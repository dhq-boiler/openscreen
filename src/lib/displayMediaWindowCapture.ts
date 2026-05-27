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

export async function startDisplayMediaWindowCapture(
	options: DisplayMediaWindowCaptureOptions,
): Promise<DisplayMediaWindowCaptureHandle> {
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

	// Request chunks every second so a crash mid-recording still leaves
	// most of the timeline on disk after stop fires.
	recorder.start(1000);

	return {
		stop: async () => {
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
		},
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
}
