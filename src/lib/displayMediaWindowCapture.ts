// Phase 7: Chromium getUserMedia + MediaRecorder fallback for capturing
// static / GPU-rendered windows that the WGC native helper can't grab.
//
// The WGC path (electron/native/wgc-capture/) handles the primary layer
// because it ships audio + editable cursor. Additional layers in a
// multi-source recording route through this module instead — Chromium's
// desktop capturer reads frames straight off the compositor, so it
// works for Win11 Notepad / Electron windows / DirectComposition
// surfaces where WGC + PrintWindow + BitBlt all came back empty.
//
// MediaRecorder output format is best-effort: prefer mp4/h264 when the
// platform's Chromium build advertises it, otherwise fall back to webm.
// Either container plays back fine in the editor's HTML <video>.

export interface DisplayMediaWindowCaptureHandle {
	stop: () => Promise<{ outputPath: string; mimeType: string }>;
	pause: () => void;
	resume: () => void;
}

/**
 * Result of {@link prepareDisplayMediaWindowCapture}: the getUserMedia
 * track and MediaRecorder are already alive, but the recorder is not
 * recording yet. Caller must invoke `commit()` (starts the recorder) or
 * `discard()` (releases the stream) before the prepared resources leak.
 *
 * `commit()` returns the same handle shape that
 * {@link startDisplayMediaWindowCapture} produces, so downstream code that
 * already speaks {@link DisplayMediaWindowCaptureHandle} stays unchanged.
 */
export interface PreparedDisplayMediaWindowCapture {
	commit: () => DisplayMediaWindowCaptureHandle;
	discard: () => void;
}

export interface DisplayMediaWindowCaptureOptions {
	/** desktopCapturer source id (e.g. "window:12345:0") */
	sourceId: string;
	/**
	 * File name (basename only) the encoded blob should be saved as. The
	 * main process joins this with RECORDINGS_DIR; renderer can't see that
	 * path directly so we keep the API one-sided.
	 */
	fileName: string;
	/** Target capture frame rate. Chromium caps to display refresh anyway. */
	fps: number;
	/** Optional max width / height — useful to bound encode bitrate. */
	maxWidth?: number;
	maxHeight?: number;
}

const PREFERRED_MIME_TYPES = [
	"video/mp4;codecs=avc1.42E01E",
	"video/mp4;codecs=h264",
	"video/webm;codecs=vp9",
	"video/webm;codecs=vp8",
	"video/webm",
];

function pickSupportedMimeType(): string {
	for (const type of PREFERRED_MIME_TYPES) {
		if (MediaRecorder.isTypeSupported(type)) {
			return type;
		}
	}
	// Final fallback: empty string lets MediaRecorder pick its default.
	return "";
}

/**
 * Acquire the desktop capture stream + create the MediaRecorder, but do
 * not start it yet. The heavy work (getUserMedia handshake, codec setup)
 * happens here so the caller can run it during the user-visible record
 * countdown; calling `commit()` at countdown end just flips
 * `recorder.start()`, which is cheap.
 *
 * `discard()` releases the stream without ever producing output — used
 * when the user cancels the countdown.
 */
export async function prepareDisplayMediaWindowCapture(
	options: DisplayMediaWindowCaptureOptions,
): Promise<PreparedDisplayMediaWindowCapture> {
	const videoConstraints = {
		mandatory: {
			chromeMediaSource: "desktop",
			chromeMediaSourceId: options.sourceId,
			...(options.maxWidth ? { maxWidth: options.maxWidth } : {}),
			...(options.maxHeight ? { maxHeight: options.maxHeight } : {}),
			maxFrameRate: options.fps,
			minFrameRate: Math.max(1, Math.floor(options.fps / 2)),
		},
	};

	const stream = await navigator.mediaDevices.getUserMedia({
		audio: false,
		video: videoConstraints as unknown as MediaTrackConstraints,
	} as unknown as MediaStreamConstraints);

	const mimeType = pickSupportedMimeType();
	const recorderOptions: MediaRecorderOptions = mimeType ? { mimeType } : {};
	const recorder = new MediaRecorder(stream, recorderOptions);
	const chunks: BlobPart[] = [];

	recorder.ondataavailable = (event) => {
		if (event.data && event.data.size > 0) {
			chunks.push(event.data);
		}
	};

	const stopPromise = new Promise<void>((resolve) => {
		recorder.onstop = () => {
			resolve();
		};
	});

	let consumed = false;

	const stop = async () => {
		if (recorder.state === "inactive") {
			return { outputPath: "", mimeType };
		}
		recorder.stop();
		await stopPromise;
		stream.getTracks().forEach((track) => track.stop());

		const effectiveType = mimeType || recorder.mimeType || "video/webm";
		const blob = new Blob(chunks, { type: effectiveType });
		const arrayBuffer = await blob.arrayBuffer();
		const saved = await window.electronAPI.saveDisplayMediaRecording({
			fileName: options.fileName,
			data: arrayBuffer,
		});
		if (!saved.success || !saved.outputPath) {
			throw new Error(saved.error ?? "save-display-media-recording failed");
		}
		return { outputPath: saved.outputPath, mimeType: effectiveType };
	};

	return {
		commit() {
			if (consumed) {
				throw new Error("PreparedDisplayMediaWindowCapture already consumed");
			}
			consumed = true;
			// Request chunks every second so a crash mid-recording still leaves
			// most of the timeline on disk after stop fires.
			recorder.start(1000);
			return {
				stop,
				pause: () => {
					if (recorder.state === "recording") {
						recorder.pause();
					}
				},
				resume: () => {
					if (recorder.state === "paused") {
						recorder.resume();
					}
				},
			};
		},
		discard() {
			if (consumed) return;
			consumed = true;
			stream.getTracks().forEach((track) => track.stop());
		},
	};
}

/**
 * Convenience one-shot that combines prepare + commit. Kept so existing
 * call sites that do not need pre-warm semantics don't have to change.
 */
export async function startDisplayMediaWindowCapture(
	options: DisplayMediaWindowCaptureOptions,
): Promise<DisplayMediaWindowCaptureHandle> {
	const prepared = await prepareDisplayMediaWindowCapture(options);
	return prepared.commit();
}
