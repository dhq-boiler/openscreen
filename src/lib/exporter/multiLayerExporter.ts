/**
 * Phase 3 second-half multi-layer exporter.
 *
 * Composes a v3 multi-layer recording into a single MP4 by playing all
 * layer videos back simultaneously, drawing each composited frame onto
 * a target canvas, and encoding through WebCodecs `VideoEncoder` +
 * Mediabunny `Mp4OutputFormat` (with `fastStart`) so the resulting MP4
 * has its `moov` atom up front and is seekable in standard players.
 *
 * Audio: the primary layer's audio is demuxed and re-encoded via
 * `AudioProcessor` into the same MP4. Additional layers contribute
 * video only (audio mixing across layers is a future follow-up).
 *
 * Layout:
 * - When `layerTransforms` are supplied, each layer is positioned and
 *   sized from its LayerTransform (matching the editor preview).
 *   zOrder controls draw order, `visible:false` skips, and tile
 *   contents follow the editor's `object-cover` semantics.
 * - Without transforms (legacy callers), layers fall back to the
 *   simple auto-grid layout (full / 1x2 / 2x2 / ...).
 *
 * Background:
 * - `wallpaper` accepts the same string the editor stores: a color
 *   (hex / rgb(...) / etc.), a CSS gradient, an image path under
 *   `/wallpapers/`, or a `file://` / `data:` / `http(s)` URL. Colors
 *   fill the canvas, images draw with `background-size: cover`, and
 *   gradients fall through to a solid `settings.background` color
 *   (CSS gradient rendering on `<canvas>` is out of scope here).
 *
 * Annotations (text / image / figure / blur):
 * - When `annotationRegions` are supplied, `renderAnnotations` is
 *   called per frame on top of the composed layers — same rendering
 *   path the single-layer FrameRenderer uses, so visual parity is
 *   preserved. Blur samples the already-composed canvas, so it covers
 *   layer pixels + wallpaper as the user sees in the editor.
 *
 * Not yet supported (tracked in multi-window-recording-design.md):
 * - Zoom regions, cursor highlights. FrameRenderer remains single-layer
 *   only for those; multi-layer projects skip them on export and the
 *   user is warned.
 * - Audio mixing across multiple layers (primary track only).
 */

import type { LayerTransform } from "@/components/video-editor/projectPersistence";
import type { AnnotationRegion, MoveRegion } from "@/components/video-editor/types";
import { resolveLayerRectAtTime } from "@/components/video-editor/types";
import type { ProjectMediaV3 } from "../recordingSession";
import { classifyWallpaper, resolveImageWallpaperUrl } from "../wallpaper";
import { renderAnnotations } from "./annotationRenderer";
import { AudioProcessor } from "./audioEncoder";
import { VideoMuxer } from "./muxer";
import { StreamingVideoDecoder } from "./streamingDecoder";
import type { ExportConfig } from "./types";

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
	/**
	 * Per-layer transforms keyed by `media.layers[i].id`. When supplied,
	 * each layer is rendered at its editor-visible position/size/zOrder
	 * instead of the legacy auto-grid layout.
	 */
	layerTransforms?: LayerTransform[];
	/**
	 * Time-bounded per-layer move animations. During [startMs, endMs] the
	 * layer's position interpolates from `from` → `to`. Applied on top of
	 * the static LayerTransform.position when rendering each frame.
	 */
	moveRegions?: MoveRegion[];
	/**
	 * Wallpaper from editor state (color string, CSS gradient, or image
	 * path). Drawn under all layers; mirrors the editor preview's
	 * background div. Gradients fall through to `settings.background`.
	 */
	wallpaper?: string;
	/**
	 * Text / image / figure / blur annotations from editor state. Drawn
	 * on top of the composed layers each frame via `renderAnnotations`,
	 * matching the single-layer FrameRenderer's pipeline so visual
	 * parity is preserved. Active windows are filtered per frame from
	 * the primary video's `currentTime`.
	 */
	annotationRegions?: AnnotationRegion[];
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

interface TransformedLayer {
	video: HTMLVideoElement;
	transform: LayerTransform;
	/** True when the current composed timestamp lies inside the layer's
	 *  recorded window [offsetMs, offsetMs+durationMs]. Layers outside their
	 *  window are skipped so a mid-session dialog doesn't linger frozen
	 *  outside the seconds it was actually captured. */
	inTimeRange: boolean;
}

function drawTransformedLayers(
	ctx: CanvasRenderingContext2D,
	canvasWidth: number,
	canvasHeight: number,
	layers: TransformedLayer[],
) {
	// Mirror DOM stacking: smaller zOrder is drawn first (sits under).
	const sorted = [...layers].sort((a, b) => a.transform.zOrder - b.transform.zOrder);
	for (const { video, transform, inTimeRange } of sorted) {
		if (transform.visible === false) continue;
		if (!inTimeRange) continue;
		if (video.readyState < 2) continue;
		const vw = video.videoWidth;
		const vh = video.videoHeight;
		if (vw === 0 || vh === 0) continue;

		const dw = Math.max(1, Math.round(transform.size.width * canvasWidth));
		const dh = Math.max(1, Math.round(transform.size.height * canvasHeight));
		const dx = Math.round(transform.position.cx * canvasWidth - dw / 2);
		const dy = Math.round(transform.position.cy * canvasHeight - dh / 2);

		// Mirror the editor's `object-cover` on `<video>` tiles: center-crop
		// the source so the visible frame matches the tile aspect.
		const tileAspect = dw / dh;
		const videoAspect = vw / vh;
		let srcX = 0;
		let srcY = 0;
		let srcW = vw;
		let srcH = vh;
		if (videoAspect > tileAspect) {
			srcW = vh * tileAspect;
			srcX = (vw - srcW) / 2;
		} else if (videoAspect < tileAspect) {
			srcH = vw / tileAspect;
			srcY = (vh - srcH) / 2;
		}
		try {
			ctx.drawImage(video, srcX, srcY, srcW, srcH, dx, dy, dw, dh);
		} catch {
			// Frame may not be decodable yet — skip.
		}
	}
}

function drawWallpaperImage(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	image: HTMLImageElement,
) {
	if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
	// CSS `background-size: cover` + `background-position: center`.
	const imgAspect = image.naturalWidth / image.naturalHeight;
	const canvasAspect = width / height;
	let drawW: number;
	let drawH: number;
	if (imgAspect > canvasAspect) {
		drawH = height;
		drawW = height * imgAspect;
	} else {
		drawW = width;
		drawH = width / imgAspect;
	}
	const drawX = (width - drawW) / 2;
	const drawY = (height - drawH) / 2;
	try {
		ctx.drawImage(image, drawX, drawY, drawW, drawH);
	} catch {
		// CORS-tainted images throw — fall through to the prior fill.
	}
}

async function loadWallpaperImage(url: string): Promise<HTMLImageElement | null> {
	return new Promise((resolve) => {
		const img = new Image();
		img.crossOrigin = "anonymous";
		img.onload = () => resolve(img);
		img.onerror = () => resolve(null);
		img.src = url;
	});
}

/**
 * Resolve the editor's `wallpaper` string into a fill color and (optionally)
 * a preloaded background image. Gradients fall through to the fallback color
 * since we can't paint a CSS gradient onto a 2D canvas without a parser.
 */
async function resolveWallpaperForExport(
	wallpaper: string | undefined,
	fallbackColor: string,
): Promise<{ color: string; image: HTMLImageElement | null }> {
	if (!wallpaper) return { color: fallbackColor, image: null };
	const classified = classifyWallpaper(wallpaper);
	if (classified.kind === "color") {
		return { color: classified.value, image: null };
	}
	if (classified.kind === "gradient") {
		return { color: fallbackColor, image: null };
	}
	try {
		const url = resolveImageWallpaperUrl(classified.path);
		const image = await loadWallpaperImage(url);
		return { color: fallbackColor, image };
	} catch {
		return { color: fallbackColor, image: null };
	}
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

export async function exportMultiLayer(
	options: MultiLayerExportOptions,
): Promise<MultiLayerExportResult> {
	const {
		media,
		settings,
		layerTransforms,
		moveRegions,
		wallpaper,
		annotationRegions,
		onProgress,
		signal,
	} = options;
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

		const transformByLayerId = new Map<string, LayerTransform>();
		if (layerTransforms) {
			for (const t of layerTransforms) transformByLayerId.set(t.layerId, t);
		}
		// Use transforms when at least one prepared layer has one; otherwise
		// fall back to the legacy auto-grid layout for backward compat with
		// callers that don't pass transforms yet.
		const useTransforms = media.layers.some((l) => transformByLayerId.has(l.id));
		const cells = useTransforms
			? []
			: computeGridLayout(prepared.length, settings.width, settings.height);

		const fallbackBg = settings.background ?? "#000000";
		const resolvedBackground = await resolveWallpaperForExport(wallpaper, fallbackBg);

		const primaryVideo = prepared[0].video;
		const primaryUrl = media.layers[0].screenVideoPath;

		// Load primary file metadata via streamingDecoder so AudioProcessor
		// can demux + re-encode the source audio into the same MP4 track.
		const audioStreamingDecoder = new StreamingVideoDecoder();
		let videoInfo: Awaited<ReturnType<StreamingVideoDecoder["loadMetadata"]>> | null = null;
		try {
			videoInfo = await audioStreamingDecoder.loadMetadata(primaryUrl);
		} catch (e) {
			console.warn("[multiLayerExporter] Could not parse primary for audio:", e);
		}
		const sourceDemuxer = audioStreamingDecoder.getDemuxer();
		const audioExportCodec =
			videoInfo?.hasAudio && sourceDemuxer
				? await AudioProcessor.selectSupportedExportCodecForSource(sourceDemuxer)
				: null;
		const hasAudio = Boolean(audioExportCodec);

		// Bitrate scales loosely with pixel-rate so 1080p60 lands around
		// 12 Mbps and 720p30 around 4 Mbps. Bounded so 4K doesn't blow up.
		const pixelRate = settings.width * settings.height * settings.fps;
		const computedBitrate = Math.min(40_000_000, Math.max(2_000_000, Math.round(pixelRate * 0.1)));
		const codec = "avc1.640033";
		const exportConfig: ExportConfig = {
			width: settings.width,
			height: settings.height,
			frameRate: settings.fps,
			bitrate: computedBitrate,
			codec,
		};

		const muxer = new VideoMuxer(exportConfig, hasAudio, audioExportCodec?.muxerCodec);
		await muxer.initialize();

		let videoDescription: Uint8Array | undefined;
		let chunkCount = 0;
		const muxingPromises: Promise<void>[] = [];
		const encoderErrorRef: { current: Error | null } = { current: null };

		const encoder = new VideoEncoder({
			output: (chunk, meta) => {
				if (meta?.decoderConfig?.description && !videoDescription) {
					const desc = meta.decoderConfig.description;
					if (desc instanceof ArrayBuffer || desc instanceof SharedArrayBuffer) {
						videoDescription = new Uint8Array(desc);
					} else if (ArrayBuffer.isView(desc)) {
						videoDescription = new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength);
					}
				}
				const isFirstChunk = chunkCount === 0;
				chunkCount++;
				const p = (async () => {
					try {
						if (isFirstChunk && videoDescription) {
							const metadata: EncodedVideoChunkMetadata = {
								decoderConfig: {
									codec,
									codedWidth: settings.width,
									codedHeight: settings.height,
									description: videoDescription,
								},
							};
							await muxer.addVideoChunk(chunk, metadata);
						} else {
							await muxer.addVideoChunk(chunk, meta);
						}
					} catch (e) {
						console.error("[multiLayerExporter] Muxing error:", e);
					}
				})();
				muxingPromises.push(p);
			},
			error: (e) => {
				encoderErrorRef.current = e instanceof Error ? e : new Error(String(e));
				console.error("[multiLayerExporter] Encoder error:", e);
			},
		});

		// Try hardware first; fall back to software if not supported.
		let encoderConfig: VideoEncoderConfig = {
			codec,
			width: settings.width,
			height: settings.height,
			bitrate: computedBitrate,
			framerate: settings.fps,
			latencyMode: "quality",
			bitrateMode: "variable",
			hardwareAcceleration: "prefer-hardware",
		};
		let support = await VideoEncoder.isConfigSupported(encoderConfig);
		if (!support.supported) {
			encoderConfig = { ...encoderConfig, hardwareAcceleration: "no-preference" };
			support = await VideoEncoder.isConfigSupported(encoderConfig);
			if (!support.supported) {
				cleanupAllLayers();
				audioStreamingDecoder.cancel();
				return { success: false, error: "Video encoder is not supported on this system." };
			}
		}
		encoder.configure(encoderConfig);

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

		// Primary's audio track flows through the source demuxer instead
		// of the playback element, so mute the element to avoid the
		// computer's speakers playing during a long export.
		primaryVideo.muted = true;
		await Promise.all(prepared.map((p) => p.video.play()));

		const primaryDuration = isFinite(primaryVideo.duration) ? primaryVideo.duration : 0;

		let cancelled = false;
		const abortHandler = () => {
			cancelled = true;
		};
		signal?.addEventListener("abort", abortHandler);

		// Annotation strokes / fonts are stored at editor-preview scale.
		// Scaling by canvas.height / 720 keeps them visually consistent
		// at higher output resolutions (1080p / 1440p / 4K), matching
		// the convention FrameRenderer uses for its single-layer path.
		const annotationScaleFactor = canvas.height / 720;

		const drawFrame = async () => {
			const currentTimeMs = Math.round(primaryVideo.currentTime * 1000);
			ctx.fillStyle = resolvedBackground.color;
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			if (resolvedBackground.image) {
				drawWallpaperImage(ctx, canvas.width, canvas.height, resolvedBackground.image);
			}
			if (useTransforms) {
				const transformedLayers: TransformedLayer[] = [];
				// Primary layer anchors the composed timeline; every other
				// layer's offset is its recorded start relative to primary.
				const primaryRecordedAtMs = Number(media.layers[0]?.recordedAtMs ?? 0);
				for (let i = 0; i < prepared.length; i++) {
					const layerId = media.layers[i].id;
					const t = transformByLayerId.get(layerId);
					// Fall back to a centered full-stage tile when a layer
					// has no transform — better than silently dropping it.
					const base: LayerTransform = t ?? {
						layerId,
						position: { cx: 0.5, cy: 0.5 },
						size: { width: 1, height: 1 },
						rotation: 0,
						zOrder: i,
						visible: true,
					};
					// Apply MoveRegion interpolation (position + size) if any
					// active region matches this layer at the current playback
					// time.
					const resolved = moveRegions
						? resolveLayerRectAtTime(
								layerId,
								currentTimeMs,
								{ position: base.position, size: base.size },
								moveRegions,
							)
						: { position: base.position, size: base.size };
					const effective: LayerTransform =
						resolved.position === base.position && resolved.size === base.size
							? base
							: { ...base, position: resolved.position, size: resolved.size };

					// Time-range gating + per-layer seek so mid-session dialogs
					// appear at the same second where they originally opened.
					// i === 0 is the primary anchor with offset 0 and no seek.
					const video = prepared[i].video;
					let inTimeRange = true;
					if (i > 0) {
						const layerRecordedAtMs = Number(media.layers[i].recordedAtMs ?? 0);
						const offsetSec =
							Number.isFinite(layerRecordedAtMs) && Number.isFinite(primaryRecordedAtMs)
								? Math.max(0, (layerRecordedAtMs - primaryRecordedAtMs) / 1000)
								: 0;
						const layerDuration = Number.isFinite(video.duration) ? video.duration : Infinity;
						const localTime = primaryVideo.currentTime - offsetSec;
						if (localTime < 0 || localTime > layerDuration + 0.05) {
							inTimeRange = false;
							if (!video.paused) {
								try {
									video.pause();
								} catch {
									/* ignore */
								}
							}
						} else {
							if (video.paused) {
								video.play().catch(() => undefined);
							}
							if (Math.abs(video.currentTime - localTime) > 0.25) {
								try {
									video.currentTime = localTime;
								} catch {
									/* ignore */
								}
							}
						}
					}

					transformedLayers.push({ video, transform: effective, inTimeRange });
				}
				drawTransformedLayers(ctx, canvas.width, canvas.height, transformedLayers);
			} else {
				// Legacy grid layout — preserved for callers that don't pass
				// transforms yet.
				for (let i = 0; i < prepared.length; i++) {
					const cell = cells[i];
					const v = prepared[i].video;
					if (v.readyState < 2) continue;
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
			}

			// Annotations / blur are drawn AFTER layers + wallpaper so
			// blur correctly samples the composed pixels underneath.
			if (annotationRegions && annotationRegions.length > 0) {
				try {
					await renderAnnotations(
						ctx,
						annotationRegions,
						canvas.width,
						canvas.height,
						currentTimeMs,
						annotationScaleFactor,
					);
				} catch {
					// Annotation render failures (e.g. unloadable image) must
					// not abort the export — just skip and continue.
				}
			}
		};

		const frameDurationUs = 1_000_000 / settings.fps;
		const maxEncodeQueue = 32;
		let frameIndex = 0;

		await new Promise<void>((resolve) => {
			let lastReportSec = -1;
			let inFlight = false;
			const tick = async () => {
				if (cancelled || encoderErrorRef.current) {
					resolve();
					return;
				}
				if (inFlight) {
					requestAnimationFrame(tick);
					return;
				}
				inFlight = true;
				try {
					await drawFrame();

					// Backpressure: wait if the encoder queue is full.
					while (
						encoder.encodeQueueSize >= maxEncodeQueue &&
						!cancelled &&
						!encoderErrorRef.current
					) {
						await new Promise((r) => setTimeout(r, 5));
					}

					if (encoder.state === "configured" && !cancelled && !encoderErrorRef.current) {
						const timestamp = Math.round(primaryVideo.currentTime * 1_000_000);
						const videoFrame = new VideoFrame(canvas, {
							timestamp,
							duration: frameDurationUs,
						});
						try {
							encoder.encode(videoFrame, { keyFrame: frameIndex % 150 === 0 });
							frameIndex++;
						} finally {
							videoFrame.close();
						}
					}
				} finally {
					inFlight = false;
				}
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

		if (encoderErrorRef.current) {
			cleanupAllLayers();
			audioStreamingDecoder.cancel();
			return { success: false, error: encoderErrorRef.current.message };
		}

		if (encoder.state === "configured") {
			await encoder.flush();
		}
		await Promise.all(muxingPromises);

		// Re-encode primary audio into the same MP4 muxer. Multi-layer
		// export doesn't yet apply trim / speed regions, so audio plays
		// through end-to-end at original rate.
		if (hasAudio && audioExportCodec && sourceDemuxer && !cancelled) {
			try {
				const audioProcessor = new AudioProcessor();
				await audioProcessor.process(
					sourceDemuxer,
					muxer,
					primaryUrl,
					undefined,
					undefined,
					primaryDuration || (videoInfo?.duration ?? 0),
					audioExportCodec,
				);
			} catch (e) {
				console.warn("[multiLayerExporter] Audio processing failed:", e);
				// Continue with video-only output rather than aborting.
			}
		}

		cleanupAllLayers();
		audioStreamingDecoder.cancel();

		if (cancelled) {
			return { success: false, error: "Export cancelled." };
		}

		const blob = await muxer.finalize();
		return { success: true, blob, mimeType: "video/mp4" };
	} catch (error) {
		cleanupAllLayers();
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
