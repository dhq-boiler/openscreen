// Builds a single stage-sized HTMLCanvasElement that composites every visible
// layer (background, Layer 1 PixiJS canvas, Layer 2/3 videos) in z-order.
//
// Phase 11 Step 3: used as the blur sampling source so AnnotationOverlay can
// read the correct pixels for Layer 2/3 mosaic samples.
//
// The previous sampling source was `app.renderer.extract.canvas(app.stage)`,
// which only contained Layer 1's PixiJS canvas. Anything outside that rect
// (Layer 2/3 video tiles) clamped to a 1px sample and rendered transparent.

import type { Application } from "pixi.js";

export type ComposeLayerSource =
	| {
			kind: "pixi";
			canvas: HTMLCanvasElement;
	  }
	| {
			kind: "video";
			video: HTMLVideoElement;
	  };

export interface ComposeStageLayer {
	layerId: string;
	zOrder: number;
	// Destination rect in stage pixel coordinates.
	rect: { x: number; y: number; width: number; height: number };
	source: ComposeLayerSource;
}

export interface ComposeStageCanvasParams {
	stageWidth: number;
	stageHeight: number;
	layers: ComposeStageLayer[];
	background?: {
		image?: HTMLImageElement | null;
		color?: string | null;
	};
}

let cachedCanvas: HTMLCanvasElement | null = null;

function getCachedCanvas(width: number, height: number): HTMLCanvasElement | null {
	if (typeof document === "undefined") return null;
	if (!cachedCanvas) {
		cachedCanvas = document.createElement("canvas");
	}
	if (cachedCanvas.width !== width) cachedCanvas.width = width;
	if (cachedCanvas.height !== height) cachedCanvas.height = height;
	return cachedCanvas;
}

function drawBackgroundColor(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	color: string,
) {
	ctx.save();
	ctx.fillStyle = color;
	ctx.fillRect(0, 0, width, height);
	ctx.restore();
}

function drawBackgroundImage(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	image: HTMLImageElement,
) {
	if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
	// Emulates CSS background-size:cover + background-position:center.
	const imgAspect = image.naturalWidth / image.naturalHeight;
	const stageAspect = width / height;
	let drawW: number;
	let drawH: number;
	if (imgAspect > stageAspect) {
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
		// CORS-tainted images throw — fall through to a black backdrop.
	}
}

function drawVideoCover(
	ctx: CanvasRenderingContext2D,
	video: HTMLVideoElement,
	dest: { x: number; y: number; width: number; height: number },
) {
	if (video.readyState < 2) return;
	if (video.videoWidth <= 0 || video.videoHeight <= 0) return;
	if (dest.width <= 0 || dest.height <= 0) return;
	// MultiLayerOverlay renders `<video>` with `object-cover`, so the displayed
	// frame is the center crop of the source that matches the tile's aspect.
	// Mirror that here so the sampled pixels line up with what the user sees.
	const tileAspect = dest.width / dest.height;
	const videoAspect = video.videoWidth / video.videoHeight;
	let srcX = 0;
	let srcY = 0;
	let srcW = video.videoWidth;
	let srcH = video.videoHeight;
	if (videoAspect > tileAspect) {
		srcW = video.videoHeight * tileAspect;
		srcX = (video.videoWidth - srcW) / 2;
	} else if (videoAspect < tileAspect) {
		srcH = video.videoWidth / tileAspect;
		srcY = (video.videoHeight - srcH) / 2;
	}
	try {
		ctx.drawImage(video, srcX, srcY, srcW, srcH, dest.x, dest.y, dest.width, dest.height);
	} catch {
		// Video can throw if the source isn't ready or is cross-origin tainted.
	}
}

function drawPixiCanvas(
	ctx: CanvasRenderingContext2D,
	canvas: HTMLCanvasElement,
	dest: { x: number; y: number; width: number; height: number },
) {
	if (canvas.width <= 0 || canvas.height <= 0) return;
	if (dest.width <= 0 || dest.height <= 0) return;
	try {
		ctx.drawImage(canvas, dest.x, dest.y, dest.width, dest.height);
	} catch {
		// drawImage can throw if the canvas was tainted.
	}
}

export function composeStageCanvas(params: ComposeStageCanvasParams): HTMLCanvasElement | null {
	const { stageWidth, stageHeight, layers, background } = params;
	if (stageWidth <= 0 || stageHeight <= 0) return null;

	const width = Math.max(1, Math.round(stageWidth));
	const height = Math.max(1, Math.round(stageHeight));
	const canvas = getCachedCanvas(width, height);
	if (!canvas) return null;

	const ctx = canvas.getContext("2d");
	if (!ctx) return null;

	ctx.clearRect(0, 0, width, height);
	drawBackgroundColor(ctx, width, height, background?.color || "#000");
	if (background?.image) {
		drawBackgroundImage(ctx, width, height, background.image);
	}

	// Mirror DOM stacking: smaller zOrder is drawn first (sits underneath).
	// Layer 1's PixiJS canvas and Layer 2/3 tiles share the same zOrder space
	// so the SettingsPanel ordering is honored.
	const sorted = [...layers].sort((a, b) => a.zOrder - b.zOrder);
	for (const layer of sorted) {
		if (layer.source.kind === "pixi") {
			drawPixiCanvas(ctx, layer.source.canvas, layer.rect);
		} else {
			drawVideoCover(ctx, layer.source.video, layer.rect);
		}
	}

	return canvas;
}

// Helper for callers that already have the PixiJS Application — keeps the
// `app.canvas` ?-chain out of the call site.
export function getPixiCanvas(app: Application | null | undefined): HTMLCanvasElement | null {
	if (!app) return null;
	const canvas = (app as unknown as { canvas?: HTMLCanvasElement }).canvas;
	return canvas instanceof HTMLCanvasElement ? canvas : null;
}
