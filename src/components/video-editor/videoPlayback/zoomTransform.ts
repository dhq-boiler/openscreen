import { BlurFilter, Container } from "pixi.js";
import { MotionBlurFilter } from "pixi-filters/motion-blur";

const PEAK_VELOCITY_PPS = 1400;
const MAX_BLUR_PX = 14;
const VELOCITY_THRESHOLD_PPS = 12;
const MAX_AMOUNT_BOOST = 2.2;

function getMotionBlurAmountResponse(motionBlurAmount: number) {
	const clampedAmount = Math.min(1, Math.max(0, motionBlurAmount));
	// Keep the low end usable while giving the top of the slider substantially more headroom.
	return clampedAmount * (1 + (MAX_AMOUNT_BOOST - 1) * clampedAmount);
}

export interface MotionBlurState {
	lastFrameTimeMs: number;
	prevCamX: number;
	prevCamY: number;
	prevCamScale: number;
	initialized: boolean;
}

export function createMotionBlurState(): MotionBlurState {
	return {
		lastFrameTimeMs: 0,
		prevCamX: 0,
		prevCamY: 0,
		prevCamScale: 1,
		initialized: false,
	};
}

interface TransformParams {
	cameraContainer: Container;
	blurFilter: BlurFilter | null;
	motionBlurFilter?: MotionBlurFilter | null;
	stageSize: { width: number; height: number };
	baseMask: { x: number; y: number; width: number; height: number };
	zoomScale: number;
	zoomProgress?: number;
	focusX: number;
	focusY: number;
	motionIntensity: number;
	motionVector?: { x: number; y: number };
	isPlaying: boolean;
	motionBlurAmount?: number;
	transformOverride?: AppliedTransform;
	motionBlurState?: MotionBlurState;
	frameTimeMs?: number;
	/** Phase 5.5: target layer for layer-local focus interpretation. */
	layerId?: string;
	/** Phase 5.5: per-layer placement on the stage. */
	layerRects?: ReadonlyMap<string, LayerRect>;
}

interface AppliedTransform {
	scale: number;
	x: number;
	y: number;
}

interface FocusFromTransformGeometry {
	stageSize: { width: number; height: number };
	baseMask: { x: number; y: number; width: number; height: number };
	zoomScale: number;
	x: number;
	y: number;
}

/**
 * Phase 5.5: per-layer focus interpretation.
 *
 * A LayerRect describes a single video layer's placement on the editor
 * stage in stage-normalized units (cx/cy are the layer center, width/
 * height are the layer size — all in 0..1 of the full stage). When a
 * ZoomRegion carries a `layerId` and the matching rect is supplied,
 * `focusX`/`focusY` are interpreted as 0..1 *within that layer*; the
 * function maps them back into stage-normalized space before computing
 * the camera transform. Without a layerId (or matching rect), focus is
 * treated as stage-normalized — i.e. backward compatible with v2 / v3
 * single-layer projects.
 */
export interface LayerRect {
	cx: number;
	cy: number;
	width: number;
	height: number;
}

/**
 * Map a layer-local focus point (cx/cy in 0..1 of the layer) back to
 * stage-normalized coordinates (0..1 of the full canvas). When no
 * layerId or matching rect is supplied, returns the input unchanged
 * (stage-normalized passthrough).
 */
export function resolveStageFocus(
	focusX: number,
	focusY: number,
	layerId: string | undefined,
	layerRects: ReadonlyMap<string, LayerRect> | undefined,
): { x: number; y: number } {
	if (!layerId || !layerRects) {
		return { x: focusX, y: focusY };
	}
	const rect = layerRects.get(layerId);
	if (!rect || rect.width <= 0 || rect.height <= 0) {
		return { x: focusX, y: focusY };
	}
	const left = rect.cx - rect.width / 2;
	const top = rect.cy - rect.height / 2;
	return {
		x: left + focusX * rect.width,
		y: top + focusY * rect.height,
	};
}

interface ZoomTransformGeometry {
	stageSize: { width: number; height: number };
	baseMask: { x: number; y: number; width: number; height: number };
	zoomScale: number;
	zoomProgress?: number;
	focusX: number;
	focusY: number;
	/** Phase 5.5: target layer for layer-local focus interpretation. */
	layerId?: string;
	/** Phase 5.5: per-layer placement on the stage. */
	layerRects?: ReadonlyMap<string, LayerRect>;
}

export function computeZoomTransform({
	stageSize,
	baseMask,
	zoomScale,
	zoomProgress = 1,
	focusX,
	focusY,
	layerId,
	layerRects,
}: ZoomTransformGeometry): AppliedTransform {
	if (
		stageSize.width <= 0 ||
		stageSize.height <= 0 ||
		baseMask.width <= 0 ||
		baseMask.height <= 0
	) {
		return { scale: 1, x: 0, y: 0 };
	}

	const progress = Math.min(1, Math.max(0, zoomProgress));
	const stageFocus = resolveStageFocus(focusX, focusY, layerId, layerRects);
	// Focus coordinates are stage-normalized (0-1 of full canvas),
	// so map directly to stage pixels, not through baseMask.
	const focusStagePxX = stageFocus.x * stageSize.width;
	const focusStagePxY = stageFocus.y * stageSize.height;
	const stageCenterX = stageSize.width / 2;
	const stageCenterY = stageSize.height / 2;
	const scale = 1 + (zoomScale - 1) * progress;
	const finalX = stageCenterX - focusStagePxX * zoomScale;
	const finalY = stageCenterY - focusStagePxY * zoomScale;

	return {
		scale,
		x: finalX * progress,
		y: finalY * progress,
	};
}

export function computeFocusFromTransform({
	stageSize,
	baseMask,
	zoomScale,
	x,
	y,
}: FocusFromTransformGeometry) {
	if (
		stageSize.width <= 0 ||
		stageSize.height <= 0 ||
		baseMask.width <= 0 ||
		baseMask.height <= 0 ||
		zoomScale <= 0
	) {
		return { cx: 0.5, cy: 0.5 };
	}

	const stageCenterX = stageSize.width / 2;
	const stageCenterY = stageSize.height / 2;
	const focusStagePxX = (stageCenterX - x) / zoomScale;
	const focusStagePxY = (stageCenterY - y) / zoomScale;

	return {
		cx: focusStagePxX / stageSize.width,
		cy: focusStagePxY / stageSize.height,
	};
}

export function applyZoomTransform({
	cameraContainer,
	blurFilter,
	motionBlurFilter,
	stageSize,
	baseMask,
	zoomScale,
	zoomProgress = 1,
	focusX,
	focusY,
	motionIntensity: _motionIntensity,
	motionVector: _motionVector,
	isPlaying,
	motionBlurAmount = 0,
	transformOverride,
	motionBlurState,
	frameTimeMs,
	layerId,
	layerRects,
}: TransformParams): AppliedTransform {
	if (
		stageSize.width <= 0 ||
		stageSize.height <= 0 ||
		baseMask.width <= 0 ||
		baseMask.height <= 0
	) {
		return { scale: 1, x: 0, y: 0 };
	}

	const transform =
		transformOverride ??
		computeZoomTransform({
			stageSize,
			baseMask,
			zoomScale,
			zoomProgress,
			focusX,
			focusY,
			layerId,
			layerRects,
		});

	// Apply position & scale to camera container
	cameraContainer.scale.set(transform.scale);
	cameraContainer.position.set(transform.x, transform.y);

	if (motionBlurState && motionBlurFilter && motionBlurAmount > 0 && isPlaying) {
		const now = frameTimeMs ?? performance.now();

		if (!motionBlurState.initialized) {
			motionBlurState.prevCamX = transform.x;
			motionBlurState.prevCamY = transform.y;
			motionBlurState.prevCamScale = transform.scale;
			motionBlurState.lastFrameTimeMs = now;
			motionBlurState.initialized = true;
			motionBlurFilter.velocity = { x: 0, y: 0 };
			motionBlurFilter.kernelSize = 5;
			motionBlurFilter.offset = 0;
			if (blurFilter) blurFilter.blur = 0;
		} else {
			const dtMs = Math.min(80, Math.max(1, now - motionBlurState.lastFrameTimeMs));
			const dtSeconds = dtMs / 1000;
			motionBlurState.lastFrameTimeMs = now;
			const amountResponse = getMotionBlurAmountResponse(motionBlurAmount);

			// Camera displacement this frame (stage-px)
			const dx = transform.x - motionBlurState.prevCamX;
			const dy = transform.y - motionBlurState.prevCamY;
			const dScale = transform.scale - motionBlurState.prevCamScale;

			motionBlurState.prevCamX = transform.x;
			motionBlurState.prevCamY = transform.y;
			motionBlurState.prevCamScale = transform.scale;

			// Velocity in px/s (translation + scale-change contribution)
			const velocityX = dx / dtSeconds;
			const velocityY = dy / dtSeconds;
			const scaleVelocity =
				Math.abs(dScale / dtSeconds) * Math.max(stageSize.width, stageSize.height) * 0.5;
			const speed = Math.sqrt(velocityX * velocityX + velocityY * velocityY) + scaleVelocity;

			const normalised = Math.min(1, speed / PEAK_VELOCITY_PPS);
			const targetBlur =
				speed < VELOCITY_THRESHOLD_PPS ? 0 : normalised * normalised * MAX_BLUR_PX * amountResponse;

			const dirMag = Math.sqrt(velocityX * velocityX + velocityY * velocityY) || 1;
			const velocityScale = targetBlur * 2.4;
			motionBlurFilter.velocity =
				targetBlur > 0
					? { x: (velocityX / dirMag) * velocityScale, y: (velocityY / dirMag) * velocityScale }
					: { x: 0, y: 0 };
			motionBlurFilter.kernelSize = targetBlur > 8 ? 15 : targetBlur > 4 ? 11 : 7;
			motionBlurFilter.offset = targetBlur > 0.5 ? -0.2 : 0;

			if (blurFilter) {
				blurFilter.blur = 0;
			}
		}
	} else {
		if (motionBlurFilter) {
			motionBlurFilter.velocity = { x: 0, y: 0 };
			motionBlurFilter.kernelSize = 5;
			motionBlurFilter.offset = 0;
		}
		if (blurFilter) {
			blurFilter.blur = 0;
		}
		if (motionBlurState) {
			motionBlurState.initialized = false;
		}
	}

	return {
		scale: transform.scale,
		x: transform.x,
		y: transform.y,
	};
}
