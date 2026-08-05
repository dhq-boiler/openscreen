#include "audio_sample_utils.h"
#include "mf_encoder.h"
#include "monitor_utils.h"
#include "wasapi_loopback_capture.h"
#include "webcam_capture.h"
#include "wgc_session.h"

#include <winrt/Windows.Foundation.h>

#include <dwmapi.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cctype>
#include <cstdint>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {

struct CaptureConfig {
    int schemaVersion = 1;
    int64_t displayId = 0;
    int64_t recordingId = 0;
    std::string sourceType = "display";
    std::string sourceId;
    std::string windowHandle;
    std::string outputPath;
    std::string webcamOutputPath;
    int fps = 60;
    int width = 0;
    int height = 0;
    MonitorBounds bounds{};
    bool hasDisplayBounds = false;
    bool captureSystemAudio = false;
    bool captureMic = false;
    bool captureCursor = false;
    bool webcamEnabled = false;
    std::string microphoneDeviceId;
    std::string microphoneDeviceName;
    double microphoneGain = 1.0;
    std::string webcamDeviceId;
    std::string webcamDeviceName;
    std::string webcamDirectShowClsid;
    int webcamWidth = 0;
    int webcamHeight = 0;
    int webcamFps = 0;
    // Phase B: when true, the helper completes init then blocks on stdin
    // for a "start" command before launching the capture loop. Lets the
    // orchestrator hide WGC + Media Foundation warmup behind the user's
    // record countdown so the moment of record-start no longer spikes
    // the GPU. Default false keeps the legacy one-shot behaviour intact.
    bool armedStart = false;
};

struct CaptureControl {
    std::atomic<bool> stopRequested = false;
    std::atomic<bool> paused = false;
    std::mutex mutex;
    std::condition_variable cv;
    std::chrono::steady_clock::time_point pauseStartedAt;
    std::chrono::steady_clock::duration totalPausedDuration{};

    int64_t pausedDurationHns() {
        std::scoped_lock lock(mutex);
        auto total = totalPausedDuration;
        if (paused.load()) {
            total += std::chrono::steady_clock::now() - pauseStartedAt;
        }
        return std::chrono::duration_cast<std::chrono::nanoseconds>(total).count() / 100;
    }

    void setPaused(bool nextPaused) {
        std::scoped_lock lock(mutex);
        if (nextPaused == paused.load()) {
            return;
        }
        if (nextPaused) {
            pauseStartedAt = std::chrono::steady_clock::now();
        } else {
            totalPausedDuration += std::chrono::steady_clock::now() - pauseStartedAt;
        }
        paused = nextPaused;
    }
};

std::wstring utf8ToWide(const std::string& value) {
    if (value.empty()) {
        return {};
    }

    const int size = MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0);
    std::wstring result(static_cast<size_t>(size), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), size);
    return result;
}

std::string wideToUtf8(const std::wstring& value) {
    if (value.empty()) {
        return {};
    }

    const int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    std::string result(static_cast<size_t>(size), '\0');
    WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr);
    return result;
}

std::string jsonEscape(const std::string& value) {
    std::string result;
    result.reserve(value.size());
    for (const char c : value) {
        switch (c) {
            case '\\':
                result += "\\\\";
                break;
            case '"':
                result += "\\\"";
                break;
            case '\n':
                result += "\\n";
                break;
            case '\r':
                result += "\\r";
                break;
            case '\t':
                result += "\\t";
                break;
            default:
                result.push_back(c);
                break;
        }
    }
    return result;
}

bool hasVisibleBgraContent(const std::vector<BYTE>& frame) {
    if (frame.size() < 4) {
        return false;
    }

    uint64_t lumaTotal = 0;
    BYTE maxLuma = 0;
    const size_t pixelCount = frame.size() / 4;
    const size_t step = std::max<size_t>(1, pixelCount / 4096);
    size_t sampledPixels = 0;
    for (size_t pixel = 0; pixel < pixelCount; pixel += step) {
        const size_t offset = pixel * 4;
        const BYTE b = frame[offset + 0];
        const BYTE g = frame[offset + 1];
        const BYTE r = frame[offset + 2];
        const BYTE luma = static_cast<BYTE>((static_cast<uint16_t>(r) * 54 + static_cast<uint16_t>(g) * 183 + static_cast<uint16_t>(b) * 19) >> 8);
        lumaTotal += luma;
        maxLuma = std::max(maxLuma, luma);
        sampledPixels += 1;
    }

    const uint64_t averageLuma = sampledPixels > 0 ? lumaTotal / sampledPixels : 0;
    return maxLuma > 24 || averageLuma > 4;
}

bool findBool(const std::string& json, const std::string& key, bool fallback) {
    auto pos = json.find("\"" + key + "\"");
    if (pos == std::string::npos) {
        return fallback;
    }
    pos = json.find(':', pos);
    if (pos == std::string::npos) {
        return fallback;
    }
    pos += 1;
    while (pos < json.size() && std::isspace(static_cast<unsigned char>(json[pos]))) {
        pos += 1;
    }
    if (json.compare(pos, 4, "true") == 0) {
        return true;
    }
    if (json.compare(pos, 5, "false") == 0) {
        return false;
    }
    return fallback;
}

int64_t findInt64(const std::string& json, const std::string& key, int64_t fallback) {
    auto pos = json.find("\"" + key + "\"");
    if (pos == std::string::npos) {
        return fallback;
    }
    pos = json.find(':', pos);
    if (pos == std::string::npos) {
        return fallback;
    }
    pos += 1;
    while (pos < json.size() && std::isspace(static_cast<unsigned char>(json[pos]))) {
        pos += 1;
    }
    try {
        return std::stoll(json.substr(pos));
    } catch (...) {
        return fallback;
    }
}

int findInt(const std::string& json, const std::string& key, int fallback) {
    return static_cast<int>(findInt64(json, key, fallback));
}

double findDouble(const std::string& json, const std::string& key, double fallback) {
    auto pos = json.find("\"" + key + "\"");
    if (pos == std::string::npos) {
        return fallback;
    }
    pos = json.find(':', pos);
    if (pos == std::string::npos) {
        return fallback;
    }
    pos += 1;
    while (pos < json.size() && std::isspace(static_cast<unsigned char>(json[pos]))) {
        pos += 1;
    }
    try {
        return std::stod(json.substr(pos));
    } catch (...) {
        return fallback;
    }
}

std::string findString(const std::string& json, const std::string& key) {
    auto pos = json.find("\"" + key + "\"");
    if (pos == std::string::npos) {
        return {};
    }
    pos = json.find(':', pos);
    if (pos == std::string::npos) {
        return {};
    }
    pos += 1;
    while (pos < json.size() && std::isspace(static_cast<unsigned char>(json[pos]))) {
        pos += 1;
    }
    if (pos >= json.size() || json[pos] != '"') {
        return {};
    }
    pos += 1;

    std::string result;
    while (pos < json.size()) {
        const char c = json[pos++];
        if (c == '"') {
            break;
        }
        if (c == '\\' && pos < json.size()) {
            const char escaped = json[pos++];
            switch (escaped) {
                case '\\':
                case '"':
                case '/':
                    result.push_back(escaped);
                    break;
                case 'n':
                    result.push_back('\n');
                    break;
                case 'r':
                    result.push_back('\r');
                    break;
                case 't':
                    result.push_back('\t');
                    break;
                default:
                    result.push_back(escaped);
                    break;
            }
            continue;
        }
        result.push_back(c);
    }
    return result;
}

std::string parseWindowHandleFromSourceId(const std::string& sourceId) {
    constexpr char prefix[] = "window:";
    if (sourceId.rfind(prefix, 0) != 0) {
        return {};
    }

    const size_t start = sizeof(prefix) - 1;
    const size_t end = sourceId.find(':', start);
    const std::string handle = sourceId.substr(start, end == std::string::npos ? std::string::npos : end - start);
    return handle.empty() ? std::string{} : handle;
}

HWND parseWindowHandle(const std::string& value) {
    if (value.empty()) {
        return nullptr;
    }

    try {
        size_t parsed = 0;
        const int base = value.rfind("0x", 0) == 0 || value.rfind("0X", 0) == 0 ? 16 : 10;
        const uint64_t handleValue = std::stoull(value, &parsed, base);
        if (parsed != value.size() || handleValue == 0) {
            return nullptr;
        }
        return reinterpret_cast<HWND>(static_cast<uintptr_t>(handleValue));
    } catch (...) {
        return nullptr;
    }
}

bool parseConfig(const std::string& json, CaptureConfig& config) {
    config.schemaVersion = findInt(json, "schemaVersion", 1);
    config.outputPath = findString(json, "screenPath");
    if (config.outputPath.empty()) {
        config.outputPath = findString(json, "outputPath");
    }
    if (config.outputPath.empty()) {
        return false;
    }

    config.recordingId = findInt64(json, "recordingId", 0);
    config.sourceType = findString(json, "sourceType");
    if (config.sourceType.empty()) {
        config.sourceType = "display";
    }
    config.sourceId = findString(json, "sourceId");
    config.windowHandle = findString(json, "windowHandle");
    if (config.windowHandle.empty()) {
        config.windowHandle = parseWindowHandleFromSourceId(config.sourceId);
    }
    config.displayId = findInt64(json, "displayId", 0);
    config.fps = std::clamp(findInt(json, "fps", 60), 1, 120);
    config.width = findInt(json, "videoWidth", findInt(json, "width", 0));
    config.height = findInt(json, "videoHeight", findInt(json, "height", 0));
    config.bounds.x = findInt(json, "displayX", 0);
    config.bounds.y = findInt(json, "displayY", 0);
    config.bounds.width = findInt(json, "displayW", 0);
    config.bounds.height = findInt(json, "displayH", 0);
    config.hasDisplayBounds = findBool(json, "hasDisplayBounds", false);
    config.captureSystemAudio = findBool(json, "captureSystemAudio", false);
    config.captureMic = findBool(json, "captureMic", false);
    config.captureCursor = findBool(json, "captureCursor", false);
    config.webcamEnabled = findBool(json, "webcamEnabled", false);
    config.armedStart = findBool(json, "armedStart", false);
    config.microphoneDeviceId = findString(json, "microphoneDeviceId");
    config.microphoneDeviceName = findString(json, "microphoneDeviceName");
    config.microphoneGain = findDouble(json, "microphoneGain", 1.0);
    config.webcamDeviceId = findString(json, "webcamDeviceId");
    config.webcamDeviceName = findString(json, "webcamDeviceName");
    config.webcamDirectShowClsid = findString(json, "webcamDirectShowClsid");
    config.webcamOutputPath = findString(json, "webcamPath");
    config.webcamWidth = findInt(json, "webcamWidth", 0);
    config.webcamHeight = findInt(json, "webcamHeight", 0);
    config.webcamFps = findInt(json, "webcamFps", 0);
    return true;
}

void readCaptureCommands(CaptureControl& control, const std::function<void(bool)>& onPauseChanged) {
    std::string line;
    while (std::getline(std::cin, line)) {
        if (line == "stop" || line == "q" || line == "quit") {
            control.stopRequested = true;
            control.cv.notify_all();
            return;
        }
        if (line == "pause") {
            control.setPaused(true);
            onPauseChanged(true);
            std::cout << "{\"event\":\"recording-paused\",\"schemaVersion\":2}" << std::endl;
            control.cv.notify_all();
            continue;
        }
        if (line == "resume") {
            control.setPaused(false);
            onPauseChanged(false);
            std::cout << "{\"event\":\"recording-resumed\",\"schemaVersion\":2}" << std::endl;
            control.cv.notify_all();
            continue;
        }
    }
    control.stopRequested = true;
    control.cv.notify_all();
}

struct EnumeratedWindow {
    HWND hwnd = nullptr;
    DWORD pid = 0;
    std::string processName;
    std::string processPath;
    std::string title;
    std::string className;
    int x = 0;
    int y = 0;
    int width = 0;
    int height = 0;
};

std::string processPathFromPid(DWORD pid) {
    if (pid == 0) {
        return {};
    }
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) {
        return {};
    }
    std::wstring buffer(1024, L'\0');
    DWORD size = static_cast<DWORD>(buffer.size());
    std::string result;
    if (QueryFullProcessImageNameW(process, 0, buffer.data(), &size)) {
        buffer.resize(size);
        result = wideToUtf8(buffer);
    }
    CloseHandle(process);
    return result;
}

std::string basenameOfPath(const std::string& fullPath) {
    if (fullPath.empty()) {
        return {};
    }
    const size_t slash = fullPath.find_last_of("\\/");
    return slash == std::string::npos ? fullPath : fullPath.substr(slash + 1);
}

BOOL CALLBACK enumWindowsCallback(HWND hwnd, LPARAM lparam) {
    auto* out = reinterpret_cast<std::vector<EnumeratedWindow>*>(lparam);

    // Skip invisible, minimized, or tool/cloaked windows so the list mirrors
    // what desktopCapturer.getSources returns for the user's picker UI.
    if (!IsWindowVisible(hwnd)) {
        return TRUE;
    }
    if (IsIconic(hwnd)) {
        return TRUE;
    }
    // Filter cloaked windows (UWP shell, hidden system windows).
    BOOL cloaked = FALSE;
    if (SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) && cloaked) {
        return TRUE;
    }

    const int titleLen = GetWindowTextLengthW(hwnd);
    if (titleLen <= 0) {
        // Untitled windows are almost never something the user recognises.
        return TRUE;
    }
    std::wstring title(static_cast<size_t>(titleLen) + 1, L'\0');
    const int copied = GetWindowTextW(hwnd, title.data(), titleLen + 1);
    title.resize(static_cast<size_t>(std::max(0, copied)));

    RECT rect{};
    if (!GetWindowRect(hwnd, &rect)) {
        return TRUE;
    }
    const int width = rect.right - rect.left;
    const int height = rect.bottom - rect.top;
    if (width <= 1 || height <= 1) {
        return TRUE;
    }

    wchar_t classBuf[256] = {};
    GetClassNameW(hwnd, classBuf, static_cast<int>(std::size(classBuf)));

    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);

    EnumeratedWindow entry;
    entry.hwnd = hwnd;
    entry.pid = pid;
    entry.processPath = processPathFromPid(pid);
    entry.processName = basenameOfPath(entry.processPath);
    entry.title = wideToUtf8(title);
    entry.className = wideToUtf8(std::wstring(classBuf));
    entry.x = rect.left;
    entry.y = rect.top;
    entry.width = width;
    entry.height = height;
    out->push_back(std::move(entry));
    return TRUE;
}

int emitWindowList() {
    std::vector<EnumeratedWindow> windows;
    EnumWindows(&enumWindowsCallback, reinterpret_cast<LPARAM>(&windows));

    std::cout << "{\"schemaVersion\":1,\"windows\":[";
    bool first = true;
    for (const auto& w : windows) {
        if (!first) {
            std::cout << ",";
        }
        first = false;
        const uintptr_t handleValue = reinterpret_cast<uintptr_t>(w.hwnd);
        std::cout << "{\"hwnd\":" << static_cast<uint64_t>(handleValue)
                  << ",\"sourceId\":\"window:" << static_cast<uint64_t>(handleValue) << ":0\""
                  << ",\"pid\":" << w.pid
                  << ",\"processName\":\"" << jsonEscape(w.processName) << "\""
                  << ",\"processPath\":\"" << jsonEscape(w.processPath) << "\""
                  << ",\"title\":\"" << jsonEscape(w.title) << "\""
                  << ",\"className\":\"" << jsonEscape(w.className) << "\""
                  << ",\"x\":" << w.x
                  << ",\"y\":" << w.y
                  << ",\"width\":" << w.width
                  << ",\"height\":" << w.height
                  << "}";
    }
    std::cout << "]}" << std::endl;
    return 0;
}

} // namespace

int main(int argc, char* argv[]) {
    if (argc < 2) {
        std::cerr << "ERROR: Missing JSON config argument" << std::endl;
        return 1;
    }

    // Non-capture utility subcommand: enumerate visible top-level windows
    // with their owning process. Emits a single JSON line on stdout, then
    // exits. Used by the source picker to offer "record every window of
    // process X" without spawning a capture pipeline.
    if (std::string(argv[1]) == "--list-windows") {
        return emitWindowList();
    }

    winrt::init_apartment(winrt::apartment_type::multi_threaded);

    CaptureConfig config;
    if (!parseConfig(argv[1], config)) {
        std::cerr << "ERROR: Failed to parse config JSON" << std::endl;
        return 1;
    }

    std::cout << "{\"event\":\"ready\",\"schemaVersion\":2}" << std::endl;

    WgcSession session;
    if (config.sourceType == "display") {
        HMONITOR monitor = findMonitorForCapture(
            config.displayId,
            config.hasDisplayBounds ? &config.bounds : nullptr);
        if (!monitor) {
            std::cerr << "ERROR: Could not resolve monitor" << std::endl;
            return 1;
        }
        if (!session.initialize(monitor, config.fps, config.captureCursor)) {
            std::cerr << "ERROR: Failed to initialize WGC display session" << std::endl;
            return 1;
        }
    } else if (config.sourceType == "window") {
        HWND window = parseWindowHandle(config.windowHandle);
        if (!window || !IsWindow(window)) {
            std::cerr << "ERROR: Native window capture requires a valid HWND" << std::endl;
            return 1;
        }
        if (!session.initialize(window, config.fps, config.captureCursor)) {
            std::cerr << "ERROR: Failed to initialize WGC window session" << std::endl;
            return 1;
        }
    } else {
        std::cerr << "ERROR: Unsupported native capture source type: " << config.sourceType << std::endl;
        return 1;
    }

    // WGC owns the captured texture size. Encoding must use that exact size
    // until a dedicated GPU scaling pass is introduced; CopyResource requires
    // matching resource dimensions.
    int width = session.captureWidth();
    int height = session.captureHeight();
    width = (std::max(2, width) / 2) * 2;
    height = (std::max(2, height) / 2) * 2;

    const int pixels = width * height;
    const int bitrate = pixels >= 3840 * 2160 ? 45'000'000 : pixels >= 2560 * 1440 ? 28'000'000 : 18'000'000;

    WebcamCapture webcamCapture;
    bool webcamActive = false;
    bool writeSeparateWebcam = false;
    if (config.webcamEnabled) {
        if (!webcamCapture.initialize(
                utf8ToWide(config.webcamDeviceId),
                utf8ToWide(config.webcamDeviceName),
                utf8ToWide(config.webcamDirectShowClsid),
                config.webcamWidth,
                config.webcamHeight,
                config.webcamFps > 0 ? config.webcamFps : config.fps)) {
            std::cerr << "ERROR: Failed to initialize native webcam capture" << std::endl;
            return 1;
        }
        std::cout << "{\"event\":\"webcam-format\",\"schemaVersion\":2,\"width\":" << webcamCapture.width()
                  << ",\"height\":" << webcamCapture.height()
                  << ",\"fps\":" << webcamCapture.fps()
                  << ",\"deviceName\":\"" << jsonEscape(wideToUtf8(webcamCapture.selectedDeviceName()))
                  << "\"}" << std::endl;
        writeSeparateWebcam = !config.webcamOutputPath.empty();
    }

    WasapiLoopbackCapture loopbackCapture;
    WasapiLoopbackCapture microphoneCapture;
    const AudioInputFormat* audioFormat = nullptr;
    AudioInputFormat encoderAudioFormat{};
    AudioInputFormat systemAudioFormat{};
    AudioInputFormat microphoneAudioFormat{};
    if (config.captureSystemAudio) {
        if (!loopbackCapture.initializeSystemLoopback()) {
            std::cerr << "ERROR: Failed to initialize WASAPI loopback capture" << std::endl;
            return 1;
        }
        systemAudioFormat = loopbackCapture.inputFormat();
        audioFormat = &loopbackCapture.inputFormat();
    }
    if (config.captureMic) {
        if (!microphoneCapture.initializeMicrophone(
                utf8ToWide(config.microphoneDeviceId),
                utf8ToWide(config.microphoneDeviceName))) {
            std::cerr << "ERROR: Failed to initialize WASAPI microphone capture" << std::endl;
            return 1;
        }
        microphoneAudioFormat = microphoneCapture.inputFormat();
        if (!audioFormat) {
            audioFormat = &microphoneCapture.inputFormat();
        }
    }
    if (audioFormat) {
        std::cout << "{\"event\":\"audio-format\",\"schemaVersion\":2,\"sampleRate\":" << audioFormat->sampleRate
                  << ",\"channels\":" << audioFormat->channels
                  << ",\"bitsPerSample\":" << audioFormat->bitsPerSample
                  << ",\"system\":" << (config.captureSystemAudio ? "true" : "false")
                  << ",\"microphone\":" << (config.captureMic ? "true" : "false");
        if (config.captureMic) {
            std::cout << ",\"microphoneDeviceName\":\""
                      << jsonEscape(wideToUtf8(microphoneCapture.selectedDeviceName())) << "\"";
        }
        std::cout << "}" << std::endl;
        encoderAudioFormat = makeAacCompatibleAudioFormat(*audioFormat);
        std::cout << "{\"event\":\"encoder-audio-format\",\"schemaVersion\":2,\"sampleRate\":"
                  << encoderAudioFormat.sampleRate
                  << ",\"channels\":" << encoderAudioFormat.channels
                  << ",\"bitsPerSample\":" << encoderAudioFormat.bitsPerSample
                  << "}" << std::endl;
    }

    MFEncoder encoder;
    if (!encoder.initialize(
            utf8ToWide(config.outputPath),
            width,
            height,
            config.fps,
            bitrate,
            session.device(),
            session.context(),
            audioFormat ? &encoderAudioFormat : nullptr)) {
        std::cerr << "ERROR: Failed to initialize Media Foundation encoder" << std::endl;
        return 1;
    }

    MFEncoder webcamEncoder;
    if (writeSeparateWebcam) {
        const int webcamPixels = std::max(1, webcamCapture.width()) * std::max(1, webcamCapture.height());
        const int webcamBitrate = webcamPixels >= 1280 * 720 ? 8'000'000 : 4'000'000;
        if (!webcamEncoder.initialize(
                utf8ToWide(config.webcamOutputPath),
                webcamCapture.width(),
                webcamCapture.height(),
                webcamCapture.fps(),
                webcamBitrate,
                session.device(),
                session.context(),
                nullptr)) {
            std::cerr << "ERROR: Failed to initialize native webcam encoder" << std::endl;
            return 1;
        }
    }

    std::mutex mutex;
    CaptureControl control;
    std::atomic<bool> firstFrameWritten = false;
    std::atomic<bool> encodeFailed = false;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> latestFrameTexture;
    int64_t latestFrameTimestampHns = 0;
    int64_t firstFrameTimestampHns = -1;
    std::vector<BYTE> latestWebcamFrame;
    int latestWebcamWidth = 0;
    int latestWebcamHeight = 0;
    uint64_t latestWebcamSequence = 0;
    bool hasVisibleWebcamFrame = false;

    // Phase 6: PrintWindow fallback so static windows (no repaint events) still
    // get encoded frames instead of a single black frame stretched across the
    // whole recording. WGC silently stops delivering frames when the source
    // window does not invalidate itself; PrintWindow forces the window to
    // render into our DC even when nothing on screen has changed.
    //
    // We only enable this for HWND sources (display capture has no HWND to
    // print). The PrintWindow buffer is allocated lazily on first use.
    std::vector<BYTE> printWindowBuffer;
    auto captureViaPrintWindow = [&](HWND hwnd, int width, int height) -> bool {
        if (!hwnd || width <= 0 || height <= 0) {
            return false;
        }

        // PrintWindow always renders from the window's TRUE top-left, which
        // includes the invisible resize border (~7px on Win10/11). WGC, by
        // contrast, only captures the visible frame
        // (DWMWA_EXTENDED_FRAME_BOUNDS). Printing straight into a
        // capture-sized buffer therefore shifts the content right and leaves a
        // black band on the left edge. To stay aligned with the real WGC
        // frames we print into a full-window-sized intermediate, then crop the
        // visible frame out into the capture-sized output buffer.
        RECT winRect{};
        if (!GetWindowRect(hwnd, &winRect)) {
            return false;
        }
        const int fullW = winRect.right - winRect.left;
        const int fullH = winRect.bottom - winRect.top;
        if (fullW <= 0 || fullH <= 0) {
            return false;
        }

        // frameRect is in screen coordinates and matches the region WGC
        // captures. The offset of its top-left inside the full window rect is
        // the invisible border we must skip when cropping the printed buffer.
        RECT frameRect{};
        int visX = 0;
        int visY = 0;
        int visW = fullW;
        int visH = fullH;
        const bool haveFrameBounds = SUCCEEDED(DwmGetWindowAttribute(
            hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &frameRect, sizeof(frameRect)));
        if (haveFrameBounds) {
            visX = std::max<LONG>(0, frameRect.left - winRect.left);
            visY = std::max<LONG>(0, frameRect.top - winRect.top);
            const int fw = frameRect.right - frameRect.left;
            const int fh = frameRect.bottom - frameRect.top;
            if (fw > 0 && fh > 0) {
                visW = std::min(fw, fullW - visX);
                visH = std::min(fh, fullH - visY);
            }
        }

        HDC screenDC = GetDC(nullptr);
        if (!screenDC) {
            return false;
        }
        HDC pwDC = CreateCompatibleDC(screenDC);
        HDC outDC = CreateCompatibleDC(screenDC);
        if (!pwDC || !outDC) {
            if (pwDC) {
                DeleteDC(pwDC);
            }
            if (outDC) {
                DeleteDC(outDC);
            }
            ReleaseDC(nullptr, screenDC);
            return false;
        }

        // Negative height => top-down DIB so the rows match D3D11 / WGC layout.
        auto makeDib = [&](int w, int h, void** bitsOut) -> HBITMAP {
            BITMAPINFO bmi{};
            bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
            bmi.bmiHeader.biWidth = w;
            bmi.bmiHeader.biHeight = -h;
            bmi.bmiHeader.biPlanes = 1;
            bmi.bmiHeader.biBitCount = 32;
            bmi.bmiHeader.biCompression = BI_RGB;
            return CreateDIBSection(screenDC, &bmi, DIB_RGB_COLORS, bitsOut, nullptr, 0);
        };

        void* pwBits = nullptr;
        void* outBits = nullptr;
        HBITMAP pwBmp = makeDib(fullW, fullH, &pwBits);
        HBITMAP outBmp = makeDib(width, height, &outBits);
        if (!pwBmp || !pwBits || !outBmp || !outBits) {
            if (pwBmp) {
                DeleteObject(pwBmp);
            }
            if (outBmp) {
                DeleteObject(outBmp);
            }
            DeleteDC(pwDC);
            DeleteDC(outDC);
            ReleaseDC(nullptr, screenDC);
            return false;
        }
        HGDIOBJ oldPw = SelectObject(pwDC, pwBmp);
        HGDIOBJ oldOut = SelectObject(outDC, outBmp);

        // PW_RENDERFULLCONTENT (0x00000002) is required for Chromium / DWM
        // composited windows; without it those targets often print as blank.
        // The macro ships in modern Windows SDKs but guard for older builds.
#ifndef PW_RENDERFULLCONTENT
#define PW_RENDERFULLCONTENT 0x00000002
#endif

        auto looksBlack = [](const void* bits, size_t byteCount) {
            // Sample every 64th pixel — a full scan on a 4K frame is 33M bytes
            // and runs every 500ms otherwise. Empty PrintWindow outputs are
            // uniformly 0 so sparse sampling is enough.
            const BYTE* p = static_cast<const BYTE*>(bits);
            const size_t stride = 64 * 4;
            for (size_t i = 0; i + 2 < byteCount; i += stride) {
                if (p[i] != 0 || p[i + 1] != 0 || p[i + 2] != 0) {
                    return false;
                }
            }
            return true;
        };

        // WS_EX_COMPOSITED hack: temporarily flip on layered/composited
        // semantics so PrintWindow re-renders the target via the
        // off-screen path that DWM uses internally. Suggested in the
        // Chromium graphics-dev discussion as a workaround for GPU-only
        // windows. Restored immediately after PrintWindow finishes.
        const LONG_PTR oldExStyle = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, oldExStyle | WS_EX_COMPOSITED);
        PrintWindow(hwnd, pwDC, PW_RENDERFULLCONTENT);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, oldExStyle);

        const size_t outByteCount = static_cast<size_t>(width) * height * 4;
        bool ok = false;
        SetStretchBltMode(outDC, HALFTONE);
        if (!looksBlack(pwBits, static_cast<size_t>(fullW) * fullH * 4)) {
            // Crop the visible frame out of the full-window render and scale it
            // into the capture-sized output buffer. This drops the invisible
            // resize border so the content stays aligned with real WGC frames.
            StretchBlt(outDC, 0, 0, width, height,
                       pwDC, visX, visY, visW, visH, SRCCOPY);
            ok = !looksBlack(outBits, outByteCount);
        }
        if (!ok) {
            // BitBlt screen fallback: when PrintWindow comes back empty (either
            // it returned FALSE or it returned TRUE with an all-zero buffer,
            // which is the common WinUI 3 / Electron / DirectComposition
            // failure mode), copy the on-screen pixels at the visible frame
            // rect. This is the same workaround WebRTC's CroppingWindowCapturer
            // uses. Trade-offs: requires the window to be visible on screen; if
            // it's partially covered the overlapping window's pixels leak in.
            RECT srcRect = haveFrameBounds ? frameRect : winRect;
            const int srcW = srcRect.right - srcRect.left;
            const int srcH = srcRect.bottom - srcRect.top;
            if (srcW > 0 && srcH > 0) {
                StretchBlt(outDC, 0, 0, width, height,
                           screenDC, srcRect.left, srcRect.top, srcW, srcH, SRCCOPY);
                ok = !looksBlack(outBits, outByteCount);
            }
        }

        // Neither PrintWindow nor the BitBlt screen copy includes the mouse
        // cursor, so fabricated frames silently ERASE the cursor that real WGC
        // frames bake in (IsCursorCaptureEnabled). Any time the scene goes
        // still for >500ms the watchdog would otherwise replace the last good
        // frame with a cursor-less one — making the cursor vanish whenever the
        // user stops moving the mouse. Draw it back in manually.
        if (ok && config.captureCursor) {
            CURSORINFO ci{};
            ci.cbSize = sizeof(CURSORINFO);
            if (GetCursorInfo(&ci) && (ci.flags & CURSOR_SHOWING) && ci.hCursor) {
                // Match WGC semantics: only bake the cursor when it actually
                // hit-tests to the captured window (not when it hovers an
                // overlapping window that happens to cover the same rect).
                const HWND underCursor = WindowFromPoint(ci.ptScreenPos);
                const bool cursorOverTarget =
                    underCursor != nullptr &&
                    (underCursor == hwnd || GetAncestor(underCursor, GA_ROOT) == hwnd);
                ICONINFO ii{};
                if (cursorOverTarget && GetIconInfo(ci.hCursor, &ii)) {
                    // Both blit paths map the window-space box
                    // (visX..visX+visW, visY..visY+visH) onto the output
                    // buffer, so map the cursor through the same transform.
                    // Coordinates all come from the same (DPI-consistent)
                    // GDI space as winRect / frameRect above.
                    const int cursorWinX =
                        ci.ptScreenPos.x - winRect.left - static_cast<int>(ii.xHotspot);
                    const int cursorWinY =
                        ci.ptScreenPos.y - winRect.top - static_cast<int>(ii.yHotspot);
                    const int drawX = static_cast<int>(
                        (cursorWinX - visX) * (static_cast<double>(width) / visW));
                    const int drawY = static_cast<int>(
                        (cursorWinY - visY) * (static_cast<double>(height) / visH));
                    // Size 0,0 without DI_DEFAULTSIZE = the cursor's actual
                    // resource size, matching how WGC bakes it. GDI clips
                    // draws outside the buffer, so no bounds check needed.
                    DrawIconEx(outDC, drawX, drawY, ci.hCursor, 0, 0, 0, nullptr, DI_NORMAL);
                    if (ii.hbmMask) {
                        DeleteObject(ii.hbmMask);
                    }
                    if (ii.hbmColor) {
                        DeleteObject(ii.hbmColor);
                    }
                }
            }
        }

        if (ok) {
            printWindowBuffer.assign(static_cast<BYTE*>(outBits),
                                     static_cast<BYTE*>(outBits) + outByteCount);
        }
        SelectObject(pwDC, oldPw);
        SelectObject(outDC, oldOut);
        DeleteObject(pwBmp);
        DeleteObject(outBmp);
        DeleteDC(pwDC);
        DeleteDC(outDC);
        ReleaseDC(nullptr, screenDC);
        return ok;
    };
    bool loggedPrintWindowFallback = false;

    // Route WGC's Closed event (source window destroyed / monitor unplugged)
    // through the same stop path as an operator "stop" command. Without this
    // the WGC pipeline can crash inside D3D/DWM (0xC0000409) shortly after the
    // source disappears — most visibly when a dialog is dismissed mid-recording
    // during a process-capture session, resulting in an mp4 without moov.
    session.setClosedCallback([&]() {
        std::cout << "{\"event\":\"source-closed\",\"schemaVersion\":2}" << std::endl;
        control.stopRequested = true;
        control.cv.notify_all();
    });

    session.setFrameCallback([&](ID3D11Texture2D* texture, int64_t timestampHns) {
        if (control.stopRequested || control.paused) {
            return;
        }

        std::scoped_lock lock(mutex);
        if (!latestFrameTexture) {
            D3D11_TEXTURE2D_DESC desc{};
            texture->GetDesc(&desc);
            desc.BindFlags = 0;
            desc.CPUAccessFlags = 0;
            desc.MiscFlags = 0;
            if (FAILED(session.device()->CreateTexture2D(&desc, nullptr, &latestFrameTexture))) {
                encodeFailed = true;
                control.stopRequested = true;
                control.cv.notify_all();
                return;
            }
        }

        session.context()->CopyResource(latestFrameTexture.Get(), texture);
        latestFrameTimestampHns = timestampHns;
        if (!firstFrameWritten.exchange(true)) {
            control.cv.notify_all();
        }
    });

    auto writeVideoFrames = [&]() {
        const auto frameDuration = std::chrono::duration_cast<std::chrono::steady_clock::duration>(
            std::chrono::duration<double>(1.0 / config.fps));
        uint64_t frameIndex = 0;
        uint64_t lastWrittenWebcamSequence = 0;
        uint64_t webcamOutputFrameIndex = 0;
        int64_t lastEncodedVideoTimestampHns = -1;

        while (!control.stopRequested && !encodeFailed) {
            {
                std::unique_lock lock(mutex);
                control.cv.wait(lock, [&] {
                    return control.stopRequested.load() ||
                        encodeFailed.load() ||
                        (!control.paused.load() && latestFrameTexture);
                });
                if (control.stopRequested || encodeFailed) {
                    break;
                }
                if (webcamActive) {
                    WebcamFrameSnapshot candidateWebcamFrame;
                    if (webcamCapture.copyLatestFrame(candidateWebcamFrame) &&
                        candidateWebcamFrame.sequence != latestWebcamSequence &&
                        hasVisibleBgraContent(candidateWebcamFrame.data)) {
                        latestWebcamFrame = std::move(candidateWebcamFrame.data);
                        latestWebcamWidth = candidateWebcamFrame.width;
                        latestWebcamHeight = candidateWebcamFrame.height;
                        latestWebcamSequence = candidateWebcamFrame.sequence;
                        hasVisibleWebcamFrame = true;
                    }
                }
                const BgraFrameView webcamFrame{
                    hasVisibleWebcamFrame && !latestWebcamFrame.empty() ? latestWebcamFrame.data() : nullptr,
                    latestWebcamWidth,
                    latestWebcamHeight,
                };
                const int64_t syntheticTimestampHns =
                    static_cast<int64_t>((frameIndex * 10'000'000ULL) / config.fps);
                const int64_t sourceTimestampHns =
                    latestFrameTimestampHns > 0 ? latestFrameTimestampHns : syntheticTimestampHns;
                if (firstFrameTimestampHns < 0) {
                    firstFrameTimestampHns = sourceTimestampHns;
                }
                int64_t frameTimestampHns =
                    std::max<int64_t>(
                        0,
                        sourceTimestampHns - firstFrameTimestampHns - control.pausedDurationHns());
                if (lastEncodedVideoTimestampHns >= 0 &&
                    frameTimestampHns <= lastEncodedVideoTimestampHns) {
                    frameTimestampHns =
                        lastEncodedVideoTimestampHns + static_cast<int64_t>(10'000'000ULL / config.fps);
                }
                if (writeSeparateWebcam && webcamFrame.data &&
                    latestWebcamSequence != lastWrittenWebcamSequence) {
                    const int64_t webcamTimestampHns = static_cast<int64_t>(
                        (webcamOutputFrameIndex * 10'000'000ULL) / std::max(1, webcamCapture.fps()));
                    if (!webcamEncoder.writeBgraFrame(webcamFrame, webcamTimestampHns)) {
                        encodeFailed = true;
                        control.stopRequested = true;
                        control.cv.notify_all();
                        return;
                    }
                    lastWrittenWebcamSequence = latestWebcamSequence;
                    webcamOutputFrameIndex += 1;
                }
                if (latestFrameTexture && !encoder.writeFrame(
                        latestFrameTexture.Get(),
                        frameTimestampHns,
                        !writeSeparateWebcam && webcamFrame.data ? &webcamFrame : nullptr)) {
                    encodeFailed = true;
                    control.stopRequested = true;
                    control.cv.notify_all();
                    return;
                }
                if (latestFrameTexture) {
                    lastEncodedVideoTimestampHns = frameTimestampHns;
                }
            }

            frameIndex += 1;
            std::this_thread::sleep_for(frameDuration);
        }
    };

    std::thread videoWriterThread;

    auto stopVideoWriter = [&]() {
        if (videoWriterThread.joinable()) {
            videoWriterThread.join();
        }
    };

    auto startVideoWriter = [&]() {
        videoWriterThread = std::thread(writeVideoFrames);
    };

    // Phase 6: periodic PrintWindow watchdog. When the WGC source is a window
    // that doesn't repaint itself (idle terminal, paused video, etc.), WGC
    // simply stops delivering frames. This thread checks how long it's been
    // since onFrameArrived last fired and, if the gap exceeds the polling
    // interval, uses PrintWindow to fabricate a fresh frame from the current
    // window pixels. The fresh frame goes into latestFrameTexture exactly
    // like a real WGC frame, so writeVideoFrames keeps emitting at the target
    // fps without any code path changes downstream.
    std::thread printWindowWatchdogThread;
    auto stopPrintWindowWatchdog = [&]() {
        if (printWindowWatchdogThread.joinable()) {
            printWindowWatchdogThread.join();
        }
    };
    auto startPrintWindowWatchdog = [&]() {
        HWND hwnd = session.windowHandle();
        if (!hwnd) {
            return; // Display (HMONITOR) capture: no window to print.
        }
        printWindowWatchdogThread = std::thread([&, hwnd]() {
            using clock = std::chrono::steady_clock;
            const auto pollInterval = std::chrono::milliseconds(500);
            const auto recreateInterval = std::chrono::seconds(3);
            const int width = session.captureWidth();
            const int height = session.captureHeight();
            clock::time_point lastRecreateAttempt{};
            while (!control.stopRequested && !encodeFailed) {
                std::this_thread::sleep_for(pollInterval);
                if (control.stopRequested || encodeFailed || control.paused) {
                    continue;
                }
                // The source window may have been destroyed since capture
                // started (dialog dismissed, process killed). Touching a
                // dead HWND from PrintWindow / SetWindowLongPtrW / D3D
                // UpdateSubresource is where the 0xC0000409 crash lives, so
                // bail out and let the main loop finalize the mp4.
                if (!IsWindow(hwnd)) {
                    std::cout << "{\"event\":\"source-window-lost\",\"schemaVersion\":2}" << std::endl;
                    control.stopRequested = true;
                    control.cv.notify_all();
                    return;
                }
                const auto lastArrived = session.lastFrameArrivedSteady();
                const auto now = clock::now();
                // Only step in once WGC has gone quiet for longer than the
                // poll interval. lastArrived defaults to clock epoch (0) so
                // the first PrintWindow fires shortly after capture start
                // even when WGC never emits a single frame.
                if (lastArrived != clock::time_point() &&
                    now - lastArrived < pollInterval) {
                    continue;
                }
                if (!captureViaPrintWindow(hwnd, width, height)) {
                    // Both PrintWindow and the BitBlt screen fallback came
                    // back empty (typical for hidden / fully occluded
                    // GPU-rendered windows). As a last-ditch attempt,
                    // recreate the WGC frame pool every few seconds — that
                    // sometimes elicits an initial frame from the new
                    // capture session. Heavy, so rate-limited.
                    if (now - lastRecreateAttempt > recreateInterval) {
                        session.recreateFramePool();
                        lastRecreateAttempt = now;
                    }
                    continue;
                }
                std::scoped_lock lock(mutex);
                if (!latestFrameTexture) {
                    D3D11_TEXTURE2D_DESC desc{};
                    desc.Width = static_cast<UINT>(width);
                    desc.Height = static_cast<UINT>(height);
                    desc.MipLevels = 1;
                    desc.ArraySize = 1;
                    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
                    desc.SampleDesc.Count = 1;
                    desc.Usage = D3D11_USAGE_DEFAULT;
                    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
                    if (FAILED(session.device()->CreateTexture2D(
                            &desc, nullptr, &latestFrameTexture))) {
                        continue;
                    }
                }
                // latestFrameTexture may already exist at the WGC capture
                // item's raw (often odd) size from the frame callback, while
                // printWindowBuffer is exactly width x height (the even-rounded
                // size). Constrain the write to that top-left box so the source
                // row pitch matches the buffer regardless of the texture's real
                // width — passing nullptr here reads past printWindowBuffer when
                // the texture is wider, corrupting the heap.
                D3D11_BOX destBox{};
                destBox.left = 0;
                destBox.top = 0;
                destBox.front = 0;
                destBox.right = static_cast<UINT>(width);
                destBox.bottom = static_cast<UINT>(height);
                destBox.back = 1;
                session.context()->UpdateSubresource(
                    latestFrameTexture.Get(),
                    0,
                    &destBox,
                    printWindowBuffer.data(),
                    static_cast<UINT>(width) * 4,
                    0);
                // Advance the synthetic timestamp by one source tick so the
                // encoder loop never sees the timestamp go backwards.
                latestFrameTimestampHns += static_cast<int64_t>(10'000'000ULL / config.fps);
                if (!loggedPrintWindowFallback) {
                    loggedPrintWindowFallback = true;
                    std::cout << "{\"event\":\"printwindow-fallback-active\","
                              << "\"reason\":\"wgc-frames-stalled\"}" << std::endl;
                }
                if (!firstFrameWritten.exchange(true)) {
                    control.cv.notify_all();
                }
            }
        });
    };

    std::unique_ptr<AudioMixer> audioMixer;
    auto startAudioCaptures = [&]() -> bool {
        if (!audioFormat) {
            return true;
        }

        audioMixer = std::make_unique<AudioMixer>(
            encoderAudioFormat,
            config.captureSystemAudio ? systemAudioFormat : encoderAudioFormat,
            config.captureMic ? microphoneAudioFormat : encoderAudioFormat,
            config.captureSystemAudio,
            config.captureMic,
            config.microphoneGain,
            [&](const BYTE* data, DWORD byteCount, int64_t timestampHns, int64_t durationHns) {
                if (!encoder.writeAudio(data, byteCount, timestampHns, durationHns)) {
                    encodeFailed = true;
                    control.stopRequested = true;
                    control.cv.notify_all();
                    return false;
                }
                return true;
            });

        if (!audioMixer->start()) {
            std::cerr << "ERROR: Failed to start native audio mixer" << std::endl;
            return false;
        }

        if (config.captureMic) {
            if (!microphoneCapture.start([&](const BYTE* data, DWORD byteCount, int64_t timestampHns, int64_t durationHns) {
                    (void)timestampHns;
                    (void)durationHns;
                    if (control.stopRequested || !audioMixer) {
                        return;
                    }

                    audioMixer->pushMicrophone(data, byteCount);
                })) {
                std::cerr << "ERROR: Failed to start WASAPI microphone capture" << std::endl;
                audioMixer->stop();
                return false;
            }
        }

        if (config.captureSystemAudio) {
            if (!loopbackCapture.start([&](const BYTE* data, DWORD byteCount, int64_t timestampHns, int64_t durationHns) {
                    (void)timestampHns;
                    (void)durationHns;
                    if (control.stopRequested || !audioMixer) {
                        return;
                    }

                    audioMixer->pushSystem(data, byteCount);
                })) {
                std::cerr << "ERROR: Failed to start WASAPI loopback capture" << std::endl;
                microphoneCapture.stop();
                audioMixer->stop();
                return false;
            }
        }

        return true;
    };

    if (!startAudioCaptures()) {
        return 1;
    }
    if (config.webcamEnabled) {
        if (!webcamCapture.start()) {
            microphoneCapture.stop();
            loopbackCapture.stop();
            if (audioMixer) {
                audioMixer->stop();
            }
            std::cerr << "ERROR: Failed to start native webcam capture" << std::endl;
            return 1;
        }
        webcamActive = true;
        const auto webcamDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
        while (std::chrono::steady_clock::now() < webcamDeadline && !hasVisibleWebcamFrame) {
            WebcamFrameSnapshot candidateWebcamFrame;
            if (webcamCapture.copyLatestFrame(candidateWebcamFrame) &&
                hasVisibleBgraContent(candidateWebcamFrame.data)) {
                latestWebcamFrame = std::move(candidateWebcamFrame.data);
                latestWebcamWidth = candidateWebcamFrame.width;
                latestWebcamHeight = candidateWebcamFrame.height;
                latestWebcamSequence = candidateWebcamFrame.sequence;
                hasVisibleWebcamFrame = true;
                break;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
        if (!hasVisibleWebcamFrame) {
            std::cerr << "WARNING: Native webcam started but no visible frame was available before screen capture"
                      << std::endl;
        }
    }

    // Phase B: in armed-start mode, init is complete but we hold off on
    // the WGC capture loop until the orchestrator gives the go-ahead via
    // stdin. The "armed" event tells the main process that prepare is
    // done and the helper is now waiting for "start". A "discard"/"quit"
    // here lets a cancelled countdown shut us down without ever calling
    // session.start(), so no output file gets created.
    if (config.armedStart) {
        std::cout << "{\"event\":\"armed\",\"schemaVersion\":2}" << std::endl;
        std::string line;
        bool gotStart = false;
        while (std::getline(std::cin, line)) {
            if (line == "start") {
                gotStart = true;
                break;
            }
            if (line == "discard" || line == "stop" || line == "q" || line == "quit") {
                webcamCapture.stop();
                microphoneCapture.stop();
                loopbackCapture.stop();
                return 0;
            }
            // Unknown command while armed — ignore and keep waiting.
        }
        if (!gotStart) {
            // stdin closed before a start arrived — exit cleanly.
            webcamCapture.stop();
            microphoneCapture.stop();
            loopbackCapture.stop();
            return 0;
        }
    }

    if (!session.start()) {
        webcamCapture.stop();
        microphoneCapture.stop();
        loopbackCapture.stop();
        if (audioMixer) {
            audioMixer->stop();
        }
        std::cerr << "ERROR: Failed to start WGC session" << std::endl;
        return 1;
    }

    std::thread stdinThread(readCaptureCommands, std::ref(control), [&](bool isPaused) {
        if (audioMixer) {
            audioMixer->setPaused(isPaused);
        }
    });

    {
        std::unique_lock lock(mutex);
        const bool started = control.cv.wait_for(lock, std::chrono::seconds(10), [&] {
            return firstFrameWritten.load() || control.stopRequested.load();
        });
        if (!started || !firstFrameWritten) {
            control.stopRequested = true;
            control.cv.notify_all();
            if (stdinThread.joinable()) {
                stdinThread.detach();
            }
            microphoneCapture.stop();
            loopbackCapture.stop();
            webcamCapture.stop();
            if (audioMixer) {
                audioMixer->stop();
            }
            session.stop();
            // Close the sink writer so the output mp4 gets a moov atom even
            // when no frames were captured. Renderers/ffprobe treat a
            // truncated file as unplayable; a properly-closed 0-duration
            // file still probes cleanly and can be dropped by the caller.
            {
                std::scoped_lock lock(mutex);
                encoder.finalize();
                if (writeSeparateWebcam) {
                    webcamEncoder.finalize();
                }
            }
            std::cerr << "ERROR: Timed out waiting for first WGC frame" << std::endl;
            return 1;
        }
    }

    if (audioMixer) {
        audioMixer->beginTimeline();
    }
    startVideoWriter();
    startPrintWindowWatchdog();

    std::cout << "{\"event\":\"recording-started\",\"schemaVersion\":2}" << std::endl;
    std::cout << "Recording started" << std::endl;

    {
        std::unique_lock lock(mutex);
        control.cv.wait(lock, [&] {
            return control.stopRequested.load();
        });
    }

    microphoneCapture.stop();
    loopbackCapture.stop();
    webcamCapture.stop();
    if (audioMixer) {
        audioMixer->stop();
    }
    stopVideoWriter();
    stopPrintWindowWatchdog();
    session.stop();
    {
        std::scoped_lock lock(mutex);
        encoder.finalize();
        if (writeSeparateWebcam) {
            webcamEncoder.finalize();
        }
    }

    if (stdinThread.joinable()) {
        stdinThread.detach();
    }

    if (encodeFailed) {
        std::cerr << "ERROR: Failed to encode WGC frame" << std::endl;
        return 1;
    }

    std::cout << "{\"event\":\"recording-stopped\",\"schemaVersion\":2,\"screenPath\":\""
              << jsonEscape(config.outputPath) << "\"";
    if (writeSeparateWebcam) {
        std::cout << ",\"webcamPath\":\"" << jsonEscape(config.webcamOutputPath) << "\"";
    }
    std::cout << "}" << std::endl;
    std::cout << "Recording stopped. Output path: " << config.outputPath << std::endl;
    return 0;
}
