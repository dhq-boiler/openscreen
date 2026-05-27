#pragma once

#include <Windows.h>
#include <d3d11.h>
#include <windows.graphics.capture.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <wrl/client.h>

#include <atomic>
#include <chrono>
#include <functional>
#include <mutex>

class WgcSession {
public:
    using FrameCallback = std::function<void(ID3D11Texture2D*, int64_t)>;

    WgcSession() = default;
    ~WgcSession();

    WgcSession(const WgcSession&) = delete;
    WgcSession& operator=(const WgcSession&) = delete;

    bool initialize(HMONITOR monitor, int fps, bool captureCursor);
    bool initialize(HWND window, int fps, bool captureCursor);
    void setFrameCallback(FrameCallback callback);
    bool start();
    void stop();

    int captureWidth() const;
    int captureHeight() const;
    ID3D11Device* device() const;
    ID3D11DeviceContext* context() const;

    // Phase 6: PrintWindow fallback support. windowHandle() is INVALID_HANDLE
    // when the session was created for a monitor (display capture); the
    // fallback should be skipped in that case. lastFrameArrivedSteady()
    // returns the steady_clock time at which the most recent WGC frame
    // landed in onFrameArrived; the value is 0 until the first frame.
    HWND windowHandle() const { return windowHandle_; }
    std::chrono::steady_clock::time_point lastFrameArrivedSteady() const {
        return std::chrono::steady_clock::time_point(
            std::chrono::steady_clock::duration(lastFrameArrivedSteadyNs_.load()));
    }

    // Phase 6 (Recreate path): tear down the frame pool / session pair and
    // build a fresh one against the same capture item. WGC sometimes emits
    // a single initial frame on session start even when the source window
    // hasn't repainted, so periodically recreating provides a frame for
    // otherwise-quiet windows where PrintWindow + BitBlt both fail.
    // Returns true when recreate succeeded; the FrameCallback set via
    // setFrameCallback is preserved. Safe to call while running.
    bool recreateFramePool();

private:
    bool createD3DDevice();
    bool createCaptureItem(HMONITOR monitor);
    bool createCaptureItem(HWND window);
    bool applySessionOptions(bool captureCursor);
    void onFrameArrived(
        winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool const& sender,
        winrt::Windows::Foundation::IInspectable const&);

    Microsoft::WRL::ComPtr<ID3D11Device> d3dDevice_;
    Microsoft::WRL::ComPtr<ID3D11DeviceContext> d3dContext_;
    winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice winrtDevice_{nullptr};
    winrt::Windows::Graphics::Capture::GraphicsCaptureItem item_{nullptr};
    winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool framePool_{nullptr};
    winrt::Windows::Graphics::Capture::GraphicsCaptureSession session_{nullptr};
    winrt::event_token frameArrivedToken_{};
    FrameCallback frameCallback_;
    std::mutex callbackMutex_;
    int width_ = 0;
    int height_ = 0;
    int fps_ = 60;
    bool captureCursor_ = false;
    bool started_ = false;
    HWND windowHandle_ = nullptr;
    // Stored as nanoseconds-since-steady-clock-epoch so it fits in an atomic
    // without a dedicated mutex. 0 means "no frame yet".
    std::atomic<int64_t> lastFrameArrivedSteadyNs_{0};
};
