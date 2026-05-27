/**
 * Phase 3 second-half multi-layer exporter.
 *
 * Composes a v3 multi-layer recording into a single MP4 by playing all
 * layer videos back simultaneously, drawing each frame onto a target
 * canvas in a simple auto-grid layout, and recording the canvas stream
 * with MediaRecorder.
 *
 * What this DOES support:
 * - 1..4 video layers, auto-laid-out as full / 1x2 / 2x2.
 * - Audio passthrough from the *primary* layer only.
 * - WebM (vp8/vp9/h264 where available) output.
 *
 * What this does NOT yet support (tracked as Phase 3.5/6 follow-ups in
 * the multi-window-recording-design.md doc):
 * - Editor effects: zoom regions, cursor highlights, annotations, blur,
 *   wallpaper background. The existing FrameRenderer is single-layer
 *   only; integrating multi-layer into it is a larger refactor.
 * - Per-layer transforms (LayerTransform) — layout here is fixed grid.
 * - Audio mixing across multiple layers.
 *
 * When a project has these editor features set, the user is warned at
 * export time that the multi-layer path will skip them. Single-layer
 * projects continue to flow through the full FrameRenderer pipeline.
 */

import type { ProjectMediaV3 } from "../recordingSession";

export interface MultiLayerExportSettings {
	/** Target canvas width in CSS pixels. */
	width: number;
	/** Target canvas height in CSS pixels. */
	height: number;
	/** Target frame rate. The canvas.captureStream rate is set from this. */
	fps: number;
	/** Background fill color (rgb/hex/css). Defaults to black. */
	background?: string;
}

export interface MultiLayerExportProgress {
	currentSeconds: number;
	totalSeconds: number;
}

export interface MultiLayerExportOptions {
	media: ProjectMediaV3;
	settings: MultiLayerExportSettings;
	onProgress?: (p: MultiLayerExportProgress) => void;
	/** Optional abort signal to cancel a running export. */
	signal?: AbortSignal;
}

export interface MultiLayerExportResult {
	success: boolean;
	blob?: Blob;
	mimeType?: string;
	error?: string;
}

interface PreparedLayer {
	video: HTMLVideoElement;
	objectUrl?: string;
}

interface CellRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/**
 * Lay out N video tiles inside a (width × height) canvas. We bias toward
 * a near-square grid: 1=full, 2=horizontal split, 3-4=2x2, 5-6=3x2, ...
 */
export function computeGridLayout(n: number, width: number, height: number): CellRect[] {
	if (n <= 0) return [];
	if (n === 1) return [{ x: 0, y: 0, w: width, h: height }];
	if (n === 2) {
		const cellW = Math.floor(width / 2);
		return [
			{ x: 0, y: 0, w: cellW, h: height },
			{ x: cellW, y: 0, w: width - cellW, h: height },
		];
	}

	const cols = Math.ceil(Math.sqrt(n));
	const rows = Math.ceil(n / cols);
	const cellW = Math.floor(width / cols);
	const cellH = Math.floor(height / rows);
	const cells: CellRect[] = [];
	for (let i = 0; i < n; i++) {
		const col = i % cols;
		const row = Math.floor(i / cols);
		cells.push({
			x: col * cellW,
			y: row * cellH,
			w: cellW,
			h: cellH,
		});
	}
	return cells;
}

function pathToObjectUrlOrSrc(path: string): { src: string; objectUrl?: string } {
	// In the Electron renderer file:// URLs are resolvable directly. If the
	// caller already passed a file:// URL, use it; otherwise wrap it.
	if (path.startsWith("file://") || path.startsWith("blob:") || path.startsWith("http")) {
		return { src: path };
	}
	return { src: `file:///${path.replace(/\\/g, "/")}` };
}

async function prepareLayers(media: ProjectMediaV3): Promise<PreparedLayer[]> {
	const prepared: PreparedLayer[] = [];
	for (const layer of media.layers) {
		const { src, objectUrl } = pathToObjectUrlOrSrc(layer.screenVideoPath);
		const video = document.createElement("video");
		video.src = src;
		video.preload = "auto";
		video.muted = true; // muted for non-primary; we re-enable primary below
		video.playsInline = true;
		video.crossOrigin = "anonymous";
		prepared.push({ video, ...(objectUrl ? { objectUrl } : {}) });

		await new Promise<void>((resolve, reject) => {
			const onLoaded = () => {
				cleanup();
				resolve();
			};
			const onError = () => {
				cleanup();
				reject(new Error(`Failed to load layer video: ${layer.screenVideoPath}`));
			};
			const cleanup = () => {
				video.removeEventListener("loadedmetadata", onLoaded);
				video.removeEventListener("error", onError);
			};
			video.addEventListener("loadedmetadata", onLoaded);
			video.addEventListener("error", onError);
		});
	}

	// Un-mute the primary layer so its audio track flows into the recorder.
	if (prepared.length > 0) {
		prepared[0].video.muted = false;
	}
	return prepared;
}

function pickMimeType(): { mime: string; container: "webm" | "mp4" } {
	const candidates: Array<{ mime: string; container: "webm" | "mp4" }> = [
		{ mime: "video/webm;codecs=h264,opus", container: "webm" },
		{ mime: "video/webm;codecs=vp9,opus", container: "webm" },
		{ mime: "video/webm;codecs=vp8,opus", container: "webm" },
		{ mime: "video/webm", container: "webm" },
	];
	for (const c of candidates) {
		if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c.mime)) {
			return c;
		}
	}
	return { mime: "video/webm", container: "webm" };
}

export async function exportMultiLayer(
	options: MultiLayerExportOptions,
): Promise<MultiLayerExportResult> {
	const { media, settings, onProgress, signal } = options;
	if (media.layers.length === 0) {
		return { success: false, error: "Cannot export an empty layer list." };
	}

	let prepared: PreparedLayer[] = [];
	const cleanupAllLayers = () => {
		for (const p of prepared) {
			try {
				p.video.pause();
			} catch {
				// ignore
			}
			p.video.removeAttribute("src");
			p.video.load();
			if (p.objectUrl) URL.revokeObjectURL(p.objectUrl);
		}
	};

	try {
		prepared = await prepareLayers(media);

		const canvas = document.createElement("canvas");
		canvas.width = settings.width;
		canvas.height = settings.height;
		const ctx = canvas.getContext("2d", { alpha: false });
		if (!ctx) {
			cleanupAllLayers();
			return { success: false, error: "Failed to obtain 2D canvas context." };
		}

		const cells = computeGridLayout(prepared.length, settings.width, settings.height);

		const canvasStream = canvas.captureStream(settings.fps);
		// Attach primary layer's audio (if present) into the output stream.
		const primaryVideo = prepared[0].video;
		try {
			const primaryStream = (
				primaryVideo as unknown as { captureStream?: () => MediaStream }
			).captureStream?.();
			if (primaryStream) {
				for (const track of primaryStream.getAudioTracks()) {
					canvasStream.addTrack(track);
				}
			}
		} catch {
			// Some platforms restrict video.captureStream — proceed video-only.
		}

		const { mime } = pickMimeType();
		const chunks: Blob[] = [];
		const recorder = new MediaRecorder(canvasStream, { mimeType: mime });
		recorder.ondataavailable = (ev) => {
			if (ev.data && ev.data.size > 0) chunks.push(ev.data);
		};

		const recorderStopped = new Promise<void>((resolve) => {
			recorder.onstop = () => resolve();
		});

		// Start playback in lockstep. We seek every layer to 0 first so the
		// first compositing frame is well-defined.
		await Promise.all(
			prepared.map(
				(p) =>
					new Promise<void>((resolve) => {
						const ensureZero = () => {
							p.video.removeEventListener("seeked", ensureZero);
							resolve();
						};
						if (p.video.currentTime === 0) {
							resolve();
							return;
						}
						p.video.addEventListener("seeked", ensureZero);
						p.video.currentTime = 0;
					}),
			),
		);

		recorder.start(1000);
		await Promise.all(prepared.map((p) => p.video.play()));

		const primaryDuration = isFinite(primaryVideo.duration) ? primaryVideo.duration : 0;
		const bgColor = settings.background ?? "#000000";

		let cancelled = false;
		const abortHandler = () => {
			cancelled = true;
		};
		signal?.addEventListener("abort", abortHandler);

		const drawFrame = () => {
			ctx.fillStyle = bgColor;
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			for (let i = 0; i < prepared.length; i++) {
				const cell = cells[i];
				const v = prepared[i].video;
				if (v.readyState < 2) continue; // metadata not yet
				const vw = v.videoWidth;
				const vh = v.videoHeight;
				if (vw === 0 || vh === 0) continue;

				// Fit (contain) inside the cell preserving aspect ratio.
				const cellRatio = cell.w / cell.h;
				const videoRatio = vw / vh;
				let drawW: number;
				let drawH: number;
				if (videoRatio > cellRatio) {
					drawW = cell.w;
					drawH = Math.round(cell.w / videoRatio);
				} else {
					drawH = cell.h;
					drawW = Math.round(cell.h * videoRatio);
				}
				const dx = cell.x + Math.round((cell.w - drawW) / 2);
				const dy = cell.y + Math.round((cell.h - drawH) / 2);
				try {
					ctx.drawImage(v, dx, dy, drawW, drawH);
				} catch {
					// Frame may not be decodable yet — skip.
				}
			}
		};

		await new Promise<void>((resolve) => {
			let lastReportSec = -1;
			const tick = () => {
				if (cancelled) {
					resolve();
					return;
				}
				drawFrame();
				const now = primaryVideo.currentTime;
				if (onProgress && Math.floor(now) !== lastReportSec) {
					lastReportSec = Math.floor(now);
					onProgress({ currentSeconds: now, totalSeconds: primaryDuration });
				}
				if (primaryVideo.ended || (primaryDuration > 0 && now >= primaryDuration - 0.01)) {
					resolve();
					return;
				}
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		});

		signal?.removeEventListener("abort", abortHandler);

		recorder.stop();
		await recorderStopped;
		for (const track of canvasStream.getTracks()) track.stop();

		cleanupAllLayers();

		if (cancelled) {
			return { success: false, error: "Export cancelled." };
		}

		const blob = new Blob(chunks, { type: mime });
		return { success: true, blob, mimeType: mime };
	} catch (error) {
		cleanupAllLayers();
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
