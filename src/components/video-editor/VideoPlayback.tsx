import {
	Application,
	BlurFilter,
	Container,
	Graphics,
	Sprite,
	Texture,
	VideoSource,
} from "pixi.js";
import { MotionBlurFilter } from "pixi-filters/motion-blur";
import type React from "react";
import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { Rnd } from "react-rnd";
import {
	getWebcamLayoutCssBoxShadow,
	type Size,
	type StyledRenderRect,
	type WebcamLayoutPreset,
	type WebcamSizePreset,
} from "@/lib/compositeLayout";
import {
	createNativeCursorMotionBlurState,
	createNativeCursorSmoothingState,
	getNativeCursorClickBounceProgress,
	getNativeCursorClickBounceScale,
	getNativeCursorMotionBlurPx,
	hasNativeCursorRecordingData,
	projectNativeCursorToLocal,
	projectNativeCursorToStage,
	resetNativeCursorMotionBlurState,
	resetNativeCursorSmoothingState,
	resolveInterpolatedNativeCursorFrame,
	resolveNativeCursorRenderAsset,
	smoothNativeCursorSample,
} from "@/lib/cursor/nativeCursor";
import { classifyWallpaper, DEFAULT_WALLPAPER, resolveImageWallpaperUrl } from "@/lib/wallpaper";
import { getCssClipPath } from "@/lib/webcamMaskShapes";
import type { CursorRecordingData } from "@/native/contracts";
import {
	type AspectRatio,
	formatAspectRatioForCSS,
	getNativeAspectRatioValue,
} from "@/utils/aspectRatioUtils";
import { AnnotationOverlay } from "./AnnotationOverlay";
import {
	DEFAULT_CURSOR_SETTINGS,
	DEFAULT_EDITOR_LAYOUT_SETTINGS,
	DEFAULT_SOURCE_DIMENSIONS,
} from "./editorDefaults";
import {
	type AnnotationRegion,
	type BlurData,
	type CursorTelemetryPoint,
	computeRotation3DContainScale,
	DEFAULT_ROTATION_3D,
	isRotation3DIdentity,
	lerpRotation3D,
	rotation3DPerspective,
	type SpeedRegion,
	type TrimRegion,
	ZOOM_DEPTH_SCALES,
	type ZoomDepth,
	type ZoomFocus,
	type ZoomRegion,
} from "./types";
import {
	AUTO_FOLLOW_RAMP_DISTANCE,
	AUTO_FOLLOW_SMOOTHING_FACTOR,
	AUTO_FOLLOW_SMOOTHING_FACTOR_MAX,
	DEFAULT_FOCUS,
	ZOOM_SCALE_DEADZONE,
	ZOOM_TRANSLATION_DEADZONE_PX,
} from "./videoPlayback/constants";
import { adaptiveSmoothFactor, smoothCursorFocus } from "./videoPlayback/cursorFollowUtils";
import {
	DEFAULT_CURSOR_CONFIG,
	PixiCursorOverlay,
	preloadCursorAssets,
} from "./videoPlayback/cursorRenderer";
import { clampFocusToStage as clampFocusToStageUtil } from "./videoPlayback/focusUtils";
import { layoutVideoContent as layoutVideoContentUtil } from "./videoPlayback/layoutUtils";
import { clamp01 } from "./videoPlayback/mathUtils";
import { updateOverlayIndicator } from "./videoPlayback/overlayUtils";
import { createVideoEventHandlers } from "./videoPlayback/videoEventHandlers";
import { findDominantRegion } from "./videoPlayback/zoomRegionUtils";
import {
	applyZoomTransform,
	computeFocusFromTransform,
	computeZoomTransform,
	createMotionBlurState,
	type LayerRect,
	type MotionBlurState,
} from "./videoPlayback/zoomTransform";

interface VideoPlaybackProps {
	videoPath: string;
	/**
	 * Phase 3: extra video layers loaded from a v3 multi-layer project.
	 * Rendered as DOM `<video>` elements overlaid on top of the PixiJS
	 * canvas in a simple grid. They do NOT yet flow through the PixiJS
	 * pipeline, so they're visible in the editor but not yet baked into
	 * exports (Phase 3.5+ pulls them into FrameRenderer).
	 */
	additionalLayerPaths?: string[];
	/**
	 * Phase 4.5: layer ids matched 1:1 with `additionalLayerPaths`. Needed
	 * for the overlay to resolve which `LayerTransform` belongs to which
	 * floating tile.
	 */
	additionalLayerIds?: string[];
	/**
	 * Phase 6.5: id of the primary layer when the project is multi-source.
	 * When set, the editor renders the PixiJS canvas inside a draggable +
	 * resizable Rnd that's driven by `layerTransforms[primaryLayerId]`,
	 * matching the way additional layers behave. Null for single-source
	 * projects, which keep their legacy full-stage central placement.
	 */
	primaryLayerId?: string | null;
	/**
	 * Phase 4.5: normalized per-layer placement (cx, cy in [0,1], size in
	 * [0,1] relative to stage). When absent or missing entries the overlay
	 * falls back to a default tile in the top-left.
	 */
	layerTransforms?: import("./projectPersistence").LayerTransform[];
	/** Phase 4.5: streamed drag/resize updates (no checkpoint per frame). */
	onLayerTransformUpdate?: (
		layerId: string,
		partial: Partial<import("./projectPersistence").LayerTransform>,
	) => void;
	/** Phase 4.5: pointer-up commit so undo/redo sees one checkpoint per gesture. */
	onLayerTransformCommit?: () => void;
	webcamVideoPath?: string;
	webcamLayoutPreset: WebcamLayoutPreset;
	webcamMaskShape?: import("./types").WebcamMaskShape;
	webcamSizePreset?: WebcamSizePreset;
	webcamPosition?: { cx: number; cy: number } | null;
	onWebcamPositionChange?: (position: { cx: number; cy: number }) => void;
	onWebcamPositionDragEnd?: () => void;
	onDurationChange: (duration: number) => void;
	onTimeUpdate: (time: number) => void;
	currentTime: number;
	onPlayStateChange: (playing: boolean) => void;
	onError: (error: string) => void;
	wallpaper?: string;
	zoomRegions: ZoomRegion[];
	selectedZoomId: string | null;
	onSelectZoom: (id: string | null) => void;
	onZoomFocusChange: (id: string, focus: ZoomFocus) => void;
	onZoomFocusDragEnd?: () => void;
	isPlaying: boolean;
	showShadow?: boolean;
	shadowIntensity?: number;
	showBlur?: boolean;
	motionBlurAmount?: number;
	borderRadius?: number;
	padding?: number;
	cropRegion?: import("./types").CropRegion;
	trimRegions?: TrimRegion[];
	speedRegions?: SpeedRegion[];
	aspectRatio: AspectRatio;
	cursorRecordingData?: CursorRecordingData | null;
	annotationRegions?: AnnotationRegion[];
	selectedAnnotationId?: string | null;
	onSelectAnnotation?: (id: string | null) => void;
	onAnnotationPositionChange?: (id: string, position: { x: number; y: number }) => void;
	onAnnotationSizeChange?: (id: string, size: { width: number; height: number }) => void;
	blurRegions?: AnnotationRegion[];
	selectedBlurId?: string | null;
	onSelectBlur?: (id: string | null) => void;
	onBlurPositionChange?: (id: string, position: { x: number; y: number }) => void;
	onBlurSizeChange?: (id: string, size: { width: number; height: number }) => void;
	onBlurDataChange?: (id: string, blurData: BlurData) => void;
	onBlurDataCommit?: () => void;
	cursorTelemetry?: CursorTelemetryPoint[];
	cursorClickTimestamps?: number[];
	showCursor?: boolean;
	cursorSize?: number;
	cursorSmoothing?: number;
	cursorMotionBlur?: number;
	cursorClickBounce?: number;
	cursorClipToBounds?: boolean;
	// When true, render the selected zoom at the playhead even while paused —
	// lets the editor preview the zoom effect without leaving the focus-edit view.
	isPreviewingZoom?: boolean;
}

export interface VideoPlaybackRef {
	video: HTMLVideoElement | null;
	app: Application | null;
	videoSprite: Sprite | null;
	videoContainer: Container | null;
	containerRef: React.RefObject<HTMLDivElement>;
	play: () => Promise<void>;
	pause: () => void;
}

function getResolvedVideoDuration(video: HTMLVideoElement): number | null {
	if (Number.isFinite(video.duration) && video.duration > 0) {
		return video.duration;
	}

	if (video.seekable.length > 0) {
		const lastRangeIndex = video.seekable.length - 1;
		const seekableEnd = video.seekable.end(lastRangeIndex);
		if (Number.isFinite(seekableEnd) && seekableEnd > 0) {
			return seekableEnd;
		}
	}

	return null;
}

function getEndedVideoDuration(video: HTMLVideoElement): number | null {
	const currentTime = video.currentTime;
	if (!Number.isFinite(currentTime) || currentTime <= 0) {
		return null;
	}

	if (video.ended) {
		return currentTime;
	}

	const resolvedDuration = getResolvedVideoDuration(video);
	const durationEpsilonSeconds = 0.05;
	if (resolvedDuration && currentTime >= resolvedDuration - durationEpsilonSeconds) {
		return resolvedDuration;
	}

	return null;
}

type AudioTrackListLike = {
	length: number;
	[index: number]: { enabled: boolean };
};

type VideoElementWithAudioTracks = HTMLVideoElement & {
	audioTracks?: AudioTrackListLike;
};

function enableAllPreviewAudioTracks(video: HTMLVideoElement) {
	const audioTracks = (video as VideoElementWithAudioTracks).audioTracks;
	if (!audioTracks || audioTracks.length <= 1) {
		return;
	}

	for (let index = 0; index < audioTracks.length; index += 1) {
		audioTracks[index].enabled = true;
	}
}

const VideoPlayback = forwardRef<VideoPlaybackRef, VideoPlaybackProps>(
	(
		{
			videoPath,
			additionalLayerPaths = [],
			additionalLayerIds = [],
			primaryLayerId = null,
			layerTransforms = [],
			onLayerTransformUpdate,
			onLayerTransformCommit,
			webcamVideoPath,
			webcamLayoutPreset,
			webcamMaskShape,
			webcamSizePreset,
			webcamPosition,
			onWebcamPositionChange,
			onWebcamPositionDragEnd,
			onDurationChange,
			onTimeUpdate,
			currentTime,
			onPlayStateChange,
			onError,
			wallpaper,
			zoomRegions,
			selectedZoomId,
			onSelectZoom,
			onZoomFocusChange,
			onZoomFocusDragEnd,
			isPlaying,
			showShadow,
			shadowIntensity = 0,
			showBlur,
			motionBlurAmount = 0,
			borderRadius = 0,
			padding = DEFAULT_EDITOR_LAYOUT_SETTINGS.padding,
			cropRegion,
			trimRegions = [],
			speedRegions = [],
			aspectRatio,
			cursorRecordingData,
			annotationRegions = [],
			selectedAnnotationId,
			onSelectAnnotation,
			onAnnotationPositionChange,
			onAnnotationSizeChange,
			blurRegions = [],
			selectedBlurId,
			onSelectBlur,
			onBlurPositionChange,
			onBlurSizeChange,
			onBlurDataChange,
			onBlurDataCommit,
			cursorTelemetry = [],
			cursorClickTimestamps = [],
			showCursor = false,
			cursorSize = DEFAULT_CURSOR_SETTINGS.size,
			cursorSmoothing = DEFAULT_CURSOR_SETTINGS.smoothing,
			cursorMotionBlur = DEFAULT_CURSOR_SETTINGS.motionBlur,
			cursorClickBounce = DEFAULT_CURSOR_SETTINGS.clickBounce,
			cursorClipToBounds = DEFAULT_CURSOR_SETTINGS.clipToBounds,
			isPreviewingZoom = false,
		},
		ref,
	) => {
		const videoRef = useRef<HTMLVideoElement | null>(null);
		const supplementalAudioRef = useRef<HTMLAudioElement | null>(null);
		const webcamVideoRef = useRef<HTMLVideoElement | null>(null);
		const containerRef = useRef<HTMLDivElement | null>(null);
		const appRef = useRef<Application | null>(null);
		const videoSpriteRef = useRef<Sprite | null>(null);
		const videoContainerRef = useRef<Container | null>(null);
		const cameraContainerRef = useRef<Container | null>(null);
		const timeUpdateAnimationRef = useRef<number | null>(null);
		const [pixiReady, setPixiReady] = useState(false);
		const [videoReady, setVideoReady] = useState(false);
		const [supplementalAudioPath, setSupplementalAudioPath] = useState<string | null>(null);
		const [overlaySize, setOverlaySize] = useState({ width: 800, height: 600 });
		const [overlayElement, setOverlayElement] = useState<HTMLDivElement | null>(null);
		const overlayRef = useRef<HTMLDivElement | null>(null);

		const focusIndicatorRef = useRef<HTMLDivElement | null>(null);
		const composite3DRef = useRef<HTMLDivElement | null>(null);
		const outerWrapperRef = useRef<HTMLDivElement | null>(null);
		const [webcamLayout, setWebcamLayout] = useState<StyledRenderRect | null>(null);
		const [webcamDimensions, setWebcamDimensions] = useState<Size | null>(null);
		const currentTimeRef = useRef(0);
		const zoomRegionsRef = useRef<ZoomRegion[]>([]);
		const cursorTelemetryRef = useRef<CursorTelemetryPoint[]>([]);
		// Phase 5.5: per-layer rects (stage-normalized) for layer-local zoom focus.
		const layerRectsRef = useRef<Map<string, LayerRect>>(new Map());
		// Phase 6.5: stage size for the primary tile Rnd. ResizeObserver below
		// keeps it in sync with the outermost wrapper so px<->normalized math
		// stays correct when the editor preview resizes.
		const [stageWrapperSize, setStageWrapperSize] = useState<{
			width: number;
			height: number;
		}>({ width: 0, height: 0 });
		// Phase 6.5: rendered video rect in stage px. Mirrors baseMaskRef so
		// the React tree can react to it (the ref alone can't trigger effects).
		// Used to one-shot-sync layerTransforms[0] with the actual painted
		// frame so the user sees Layer 1's outline align with the video, not
		// the padded wallpaper area.
		const [baseMaskState, setBaseMaskState] = useState<{
			x: number;
			y: number;
			width: number;
			height: number;
		}>({ x: 0, y: 0, width: 0, height: 0 });
		const primaryRectSyncedRef = useRef(false);
		// Phase 6.5: hoisted up so the layoutVideoContent useCallback below
		// can list enablePrimaryTile in its deps without a TDZ error. Recomputed
		// every render; cheap because it's just a find() + boolean.
		const primaryTransform =
			primaryLayerId != null
				? (layerTransforms.find((t) => t.layerId === primaryLayerId) ?? null)
				: null;
		const enablePrimaryTile = Boolean(
			primaryTransform && additionalLayerPaths.length > 0 && primaryLayerId,
		);
		const cursorClickTimestampsRef = useRef<number[]>([]);
		const selectedZoomIdRef = useRef<string | null>(null);
		const animationStateRef = useRef({
			scale: 1,
			focusX: DEFAULT_FOCUS.cx,
			focusY: DEFAULT_FOCUS.cy,
			progress: 0,
			x: 0,
			y: 0,
			appliedScale: 1,
		});
		const blurFilterRef = useRef<BlurFilter | null>(null);
		const motionBlurFilterRef = useRef<MotionBlurFilter | null>(null);
		const isDraggingFocusRef = useRef(false);
		const isDraggingWebcamRef = useRef(false);
		const webcamDragOffsetRef = useRef({ dx: 0, dy: 0 });
		const stageSizeRef = useRef({ width: 0, height: 0 });
		const videoSizeRef = useRef({ width: 0, height: 0 });
		const baseScaleRef = useRef(1);
		const baseOffsetRef = useRef({ x: 0, y: 0 });
		const baseMaskRef = useRef({ x: 0, y: 0, width: 0, height: 0 });
		const cropBoundsRef = useRef({ startX: 0, endX: 0, startY: 0, endY: 0 });
		const maskGraphicsRef = useRef<Graphics | null>(null);
		const isPlayingRef = useRef(isPlaying);
		const isSeekingRef = useRef(false);
		const isScrubbingRef = useRef(false);
		const scrubEndTimerRef = useRef<number | null>(null);
		const [isScrubbing, setIsScrubbing] = useState(false);
		const allowPlaybackRef = useRef(false);
		const lockedVideoDimensionsRef = useRef<{
			width: number;
			height: number;
		} | null>(null);
		const layoutVideoContentRef = useRef<(() => void) | null>(null);
		const trimRegionsRef = useRef<TrimRegion[]>([]);
		const speedRegionsRef = useRef<SpeedRegion[]>([]);
		const motionBlurAmountRef = useRef(motionBlurAmount);
		const cursorOverlayRef = useRef<PixiCursorOverlay | null>(null);
		const showCursorRef = useRef(showCursor);
		const cursorSizeRef = useRef(cursorSize);
		const cursorSmoothingRef = useRef(cursorSmoothing);
		const cursorMotionBlurRef = useRef(cursorMotionBlur);
		const cursorClickBounceRef = useRef(cursorClickBounce);
		const cursorClipToBoundsRef = useRef(cursorClipToBounds);
		const isPreviewingZoomRef = useRef(isPreviewingZoom);
		const motionBlurStateRef = useRef<MotionBlurState>(createMotionBlurState());
		const onTimeUpdateRef = useRef(onTimeUpdate);
		const onPlayStateChangeRef = useRef(onPlayStateChange);
		const videoReadyRafRef = useRef<number | null>(null);
		const smoothedAutoFocusRef = useRef<ZoomFocus | null>(null);
		const prevTargetProgressRef = useRef(0);
		const durationResolutionTimeoutRef = useRef<number | null>(null);
		const lastResolvedDurationRef = useRef<number | null>(null);
		const isResolvingDurationRef = useRef(false);
		const hasNativeCursorRecordingRef = useRef(false);
		const cursorRecordingDataRef = useRef(cursorRecordingData);
		const cropRegionRef = useRef(cropRegion);
		const nativeCursorSpriteRef = useRef<Sprite | null>(null);
		const nativeCursorTextureIdRef = useRef<string | null>(null);
		const nativeCursorImageRef = useRef<HTMLImageElement | null>(null);
		const nativeCursorImageIdRef = useRef<string | null>(null);
		const nativeCursorSmoothingStateRef = useRef(createNativeCursorSmoothingState());
		const nativeCursorMotionBlurStateRef = useRef(createNativeCursorMotionBlurState());
		const nativeCursorClipRef = useRef<HTMLDivElement | null>(null);
		const borderRadiusRef = useRef<number>(0);

		const hasNativeCursorRecording = useMemo(
			() => hasNativeCursorRecordingData(cursorRecordingData),
			[cursorRecordingData],
		);

		const syncResolvedDuration = useCallback(
			(video: HTMLVideoElement) => {
				const resolvedDuration = getResolvedVideoDuration(video);
				if (!resolvedDuration) {
					return false;
				}

				const normalizedDuration = Math.round(resolvedDuration * 1000) / 1000;
				if (lastResolvedDurationRef.current !== normalizedDuration) {
					lastResolvedDurationRef.current = normalizedDuration;
					onDurationChange(normalizedDuration);
				}

				return true;
			},
			[onDurationChange],
		);

		const forceResolveDuration = useCallback(
			(video: HTMLVideoElement) => {
				if (isResolvingDurationRef.current) {
					return;
				}

				if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
					return;
				}

				isResolvingDurationRef.current = true;
				const previousMuted = video.muted;

				const finalize = () => {
					video.removeEventListener("durationchange", handleProgress);
					video.removeEventListener("timeupdate", handleProgress);
					video.removeEventListener("loadeddata", handleProgress);
					video.removeEventListener("ended", handleProgress);
					if (durationResolutionTimeoutRef.current) {
						clearTimeout(durationResolutionTimeoutRef.current);
						durationResolutionTimeoutRef.current = null;
					}
					video.muted = previousMuted;
					isResolvingDurationRef.current = false;
				};

				const resolveCurrentDuration = () => {
					if (syncResolvedDuration(video)) {
						return true;
					}

					const endedDuration = getEndedVideoDuration(video);
					if (endedDuration) {
						lastResolvedDurationRef.current = null;
						onDurationChange(Math.round(endedDuration * 1000) / 1000);
						return true;
					}

					return false;
				};

				const handleProgress = () => {
					if (!resolveCurrentDuration()) {
						return;
					}

					try {
						video.pause();
						video.currentTime = 0;
					} catch {
						// no-op
					}
					currentTimeRef.current = 0;
					finalize();
				};

				video.addEventListener("durationchange", handleProgress);
				video.addEventListener("timeupdate", handleProgress);
				video.addEventListener("loadeddata", handleProgress);
				video.addEventListener("ended", handleProgress);
				durationResolutionTimeoutRef.current = window.setTimeout(() => {
					handleProgress();
					finalize();
				}, 1500);
				video.muted = true;

				const playAttempt = video.play();
				if (playAttempt && typeof playAttempt.catch === "function") {
					playAttempt.catch(() => {
						try {
							video.currentTime = Math.max(video.currentTime, 0.1);
						} catch {
							finalize();
						}
					});
				}

				try {
					video.currentTime = Math.max(video.currentTime, 0.1);
				} catch {
					finalize();
				}
			},
			[onDurationChange, syncResolvedDuration],
		);

		const clampFocusToStage = useCallback((focus: ZoomFocus, depth: ZoomDepth) => {
			return clampFocusToStageUtil(focus, depth, stageSizeRef.current);
		}, []);

		const updateOverlayForRegion = useCallback(
			(region: ZoomRegion | null, focusOverride?: ZoomFocus) => {
				const overlayEl = overlayRef.current;
				const indicatorEl = focusIndicatorRef.current;

				if (!overlayEl || !indicatorEl) {
					return;
				}

				// Update stage size from overlay dimensions
				const stageWidth = overlayEl.clientWidth;
				const stageHeight = overlayEl.clientHeight;
				if (stageWidth && stageHeight) {
					stageSizeRef.current = { width: stageWidth, height: stageHeight };
				}

				updateOverlayIndicator({
					overlayEl,
					indicatorEl,
					region,
					focusOverride,
					videoSize: videoSizeRef.current,
					baseScale: baseScaleRef.current,
					isPlaying: isPlayingRef.current,
				});
			},
			[],
		);

		const layoutVideoContent = useCallback(() => {
			const container = containerRef.current;
			const app = appRef.current;
			const videoSprite = videoSpriteRef.current;
			const maskGraphics = maskGraphicsRef.current;
			const videoElement = videoRef.current;
			const cameraContainer = cameraContainerRef.current;

			if (
				!container ||
				!app ||
				!videoSprite ||
				!maskGraphics ||
				!videoElement ||
				!cameraContainer
			) {
				return;
			}

			// Lock video dimensions on first layout to prevent resize issues
			if (
				!lockedVideoDimensionsRef.current &&
				videoElement.videoWidth > 0 &&
				videoElement.videoHeight > 0
			) {
				lockedVideoDimensionsRef.current = {
					width: videoElement.videoWidth,
					height: videoElement.videoHeight,
				};
			}

			// Phase 6.5: when the primary is wrapped by a Rnd that's already
			// sized to the padded content area, do NOT apply padding again
			// inside the PixiJS canvas — otherwise the layoutUtils paddingScale
			// stacks (0.8 * 0.8 = 0.64) and the rendered video sits inside an
			// extra wallpaper margin within Layer 1's outline.
			const effectivePadding = enablePrimaryTile ? 0 : padding;
			const result = layoutVideoContentUtil({
				container,
				app,
				videoSprite,
				maskGraphics,
				videoElement,
				cropRegion,
				lockedVideoDimensions: lockedVideoDimensionsRef.current,
				borderRadius,
				padding: effectivePadding,
				webcamDimensions,
				webcamLayoutPreset,
				webcamSizePreset,
				webcamPosition,
				webcamMaskShape,
			});

			if (result) {
				stageSizeRef.current = result.stageSize;
				videoSizeRef.current = result.videoSize;
				baseScaleRef.current = result.baseScale;
				baseOffsetRef.current = result.baseOffset;
				baseMaskRef.current = result.maskRect;
				setBaseMaskState(result.maskRect);
				borderRadiusRef.current = result.maskBorderRadius;
				cropBoundsRef.current = result.cropBounds;
				setWebcamLayout(result.webcamRect);

				// Reset camera container to identity
				cameraContainer.scale.set(1);
				cameraContainer.position.set(0, 0);

				const selectedId = selectedZoomIdRef.current;
				const activeRegion = selectedId
					? (zoomRegionsRef.current.find((region) => region.id === selectedId) ?? null)
					: null;

				updateOverlayForRegion(activeRegion);
			}
		}, [
			updateOverlayForRegion,
			cropRegion,
			borderRadius,
			padding,
			enablePrimaryTile,
			webcamDimensions,
			webcamLayoutPreset,
			webcamSizePreset,
			webcamPosition,
			webcamMaskShape,
		]);

		useEffect(() => {
			layoutVideoContentRef.current = layoutVideoContent;
		}, [layoutVideoContent]);

		const setOverlayRefs = useCallback((node: HTMLDivElement | null) => {
			overlayRef.current = node;
			setOverlayElement(node);
		}, []);

		const selectedZoom = useMemo(() => {
			if (!selectedZoomId) return null;
			return zoomRegions.find((region) => region.id === selectedZoomId) ?? null;
		}, [zoomRegions, selectedZoomId]);

		useImperativeHandle(ref, () => ({
			video: videoRef.current,
			app: appRef.current,
			videoSprite: videoSpriteRef.current,
			videoContainer: videoContainerRef.current,
			containerRef,
			play: async () => {
				const vid = videoRef.current;
				if (!vid) return;
				try {
					allowPlaybackRef.current = true;
					enableAllPreviewAudioTracks(vid);
					await vid.play().catch((err) => {
						console.log("PLAY ERROR:", err);
						throw err;
					});
					const supplementalAudio = supplementalAudioRef.current;
					if (supplementalAudio) {
						supplementalAudio.currentTime = vid.currentTime;
						supplementalAudio.playbackRate = vid.playbackRate;
						await supplementalAudio.play().catch(() => {
							// The main video remains the source of truth for playback state.
						});
					}
				} catch (error) {
					allowPlaybackRef.current = false;
					throw error;
				}
			},
			pause: () => {
				const video = videoRef.current;
				allowPlaybackRef.current = false;
				if (!video) {
					return;
				}
				video.pause();
				supplementalAudioRef.current?.pause();
			},
		}));

		const updateFocusFromClientPoint = (clientX: number, clientY: number) => {
			const overlayEl = overlayRef.current;
			if (!overlayEl) return;

			const regionId = selectedZoomIdRef.current;
			if (!regionId) return;

			const region = zoomRegionsRef.current.find((r) => r.id === regionId);
			if (!region) return;

			const rect = overlayEl.getBoundingClientRect();
			const stageWidth = rect.width;
			const stageHeight = rect.height;

			if (!stageWidth || !stageHeight) {
				return;
			}

			stageSizeRef.current = { width: stageWidth, height: stageHeight };

			const localX = clientX - rect.left;
			const localY = clientY - rect.top;

			const unclampedFocus: ZoomFocus = {
				cx: clamp01(localX / stageWidth),
				cy: clamp01(localY / stageHeight),
			};
			const clampedFocus = clampFocusToStage(unclampedFocus, region.depth);

			onZoomFocusChange(region.id, clampedFocus);
			updateOverlayForRegion({ ...region, focus: clampedFocus }, clampedFocus);
		};

		const handleOverlayPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
			if (isPlayingRef.current) return;
			const regionId = selectedZoomIdRef.current;
			if (!regionId) return;
			const region = zoomRegionsRef.current.find((r) => r.id === regionId);
			if (!region) return;
			if (region.focusMode === "auto") return;
			onSelectZoom(region.id);
			event.preventDefault();
			isDraggingFocusRef.current = true;
			event.currentTarget.setPointerCapture(event.pointerId);
			updateFocusFromClientPoint(event.clientX, event.clientY);
		};

		const handleOverlayPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
			if (!isDraggingFocusRef.current) return;
			event.preventDefault();
			updateFocusFromClientPoint(event.clientX, event.clientY);
		};

		const endFocusDrag = (event: React.PointerEvent<HTMLDivElement>) => {
			if (!isDraggingFocusRef.current) return;
			isDraggingFocusRef.current = false;
			try {
				event.currentTarget.releasePointerCapture(event.pointerId);
			} catch {
				// Pointer may already be released.
			}
			onZoomFocusDragEnd?.();
		};

		const handleOverlayPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
			endFocusDrag(event);
		};

		const handleOverlayPointerLeave = (event: React.PointerEvent<HTMLDivElement>) => {
			endFocusDrag(event);
		};

		// ── Webcam PiP drag handlers ──

		const handleWebcamPointerDown = (event: React.PointerEvent<HTMLVideoElement>) => {
			if (isPlayingRef.current) return;
			if (webcamLayoutPreset !== "picture-in-picture") return;
			event.preventDefault();
			event.stopPropagation();
			isDraggingWebcamRef.current = true;
			event.currentTarget.setPointerCapture(event.pointerId);

			const webcamEl = event.currentTarget;
			const webcamRect = webcamEl.getBoundingClientRect();
			webcamDragOffsetRef.current = {
				dx: event.clientX - (webcamRect.left + webcamRect.width / 2),
				dy: event.clientY - (webcamRect.top + webcamRect.height / 2),
			};
		};

		const handleWebcamPointerMove = (event: React.PointerEvent<HTMLVideoElement>) => {
			if (!isDraggingWebcamRef.current) return;
			event.preventDefault();
			event.stopPropagation();

			const containerEl = containerRef.current;
			if (!containerEl || !onWebcamPositionChange) return;

			const containerRect = containerEl.getBoundingClientRect();
			const cx = clamp01(
				(event.clientX - webcamDragOffsetRef.current.dx - containerRect.left) / containerRect.width,
			);
			const cy = clamp01(
				(event.clientY - webcamDragOffsetRef.current.dy - containerRect.top) / containerRect.height,
			);
			onWebcamPositionChange({ cx, cy });
		};

		const handleWebcamPointerUp = (event: React.PointerEvent<HTMLVideoElement>) => {
			if (!isDraggingWebcamRef.current) return;
			isDraggingWebcamRef.current = false;
			try {
				event.currentTarget.releasePointerCapture(event.pointerId);
			} catch {
				// Pointer may already be released.
			}
			onWebcamPositionDragEnd?.();
		};

		useEffect(() => {
			zoomRegionsRef.current = zoomRegions;
		}, [zoomRegions]);

		useEffect(() => {
			const next = new Map<string, LayerRect>();
			for (const t of layerTransforms) {
				next.set(t.layerId, {
					cx: t.position.cx,
					cy: t.position.cy,
					width: t.size.width,
					height: t.size.height,
				});
			}
			layerRectsRef.current = next;
		}, [layerTransforms]);

		// Phase 6.5: observe the outer wrapper so Rnd math stays accurate even
		// when the preview gets resized by the splitter or fullscreen toggle.
		useEffect(() => {
			const el = outerWrapperRef.current;
			if (!el) return;
			const update = () => {
				setStageWrapperSize({ width: el.clientWidth, height: el.clientHeight });
			};
			update();
			const observer = new ResizeObserver(update);
			observer.observe(el);
			return () => observer.disconnect();
		}, []);

		// Phase 6.5: on first paint after layout, snap the primary Rnd to the
		// actual rendered video rect (baseMask). Project files that have
		// already been moved by the user are skipped — we detect "still at
		// the default" by checking the symmetric width/height + centered
		// position produced by defaultLayerTransformsForMedia. This sync runs
		// exactly once per VideoPlayback mount.
		useEffect(() => {
			if (primaryRectSyncedRef.current) return;
			if (!primaryLayerId || !onLayerTransformUpdate) return;
			if (additionalLayerPaths.length === 0) return;
			if (baseMaskState.width <= 0 || baseMaskState.height <= 0) return;
			if (stageWrapperSize.width <= 0 || stageWrapperSize.height <= 0) return;

			const currentPrimary = layerTransforms.find((t) => t.layerId === primaryLayerId);
			if (!currentPrimary) return;

			const isAtDefault =
				Math.abs(currentPrimary.position.cx - 0.5) < 0.005 &&
				Math.abs(currentPrimary.position.cy - 0.5) < 0.005 &&
				Math.abs(currentPrimary.size.width - currentPrimary.size.height) < 0.005;

			if (!isAtDefault) {
				primaryRectSyncedRef.current = true;
				return;
			}

			const cx = (baseMaskState.x + baseMaskState.width / 2) / stageWrapperSize.width;
			const cy = (baseMaskState.y + baseMaskState.height / 2) / stageWrapperSize.height;
			const width = baseMaskState.width / stageWrapperSize.width;
			const height = baseMaskState.height / stageWrapperSize.height;
			onLayerTransformUpdate(primaryLayerId, {
				position: { cx, cy },
				size: { width, height },
			});
			onLayerTransformCommit?.();
			primaryRectSyncedRef.current = true;
		}, [
			baseMaskState,
			stageWrapperSize,
			primaryLayerId,
			additionalLayerPaths.length,
			layerTransforms,
			onLayerTransformUpdate,
			onLayerTransformCommit,
		]);

		useEffect(() => {
			cursorTelemetryRef.current = cursorTelemetry;
		}, [cursorTelemetry]);

		useEffect(() => {
			cursorClickTimestampsRef.current = cursorClickTimestamps;
		}, [cursorClickTimestamps]);

		useEffect(() => {
			selectedZoomIdRef.current = selectedZoomId;
		}, [selectedZoomId]);

		useEffect(() => {
			isPlayingRef.current = isPlaying;
		}, [isPlaying]);

		useEffect(() => {
			trimRegionsRef.current = trimRegions;
		}, [trimRegions]);

		useEffect(() => {
			speedRegionsRef.current = speedRegions;
		}, [speedRegions]);

		useEffect(() => {
			motionBlurAmountRef.current = motionBlurAmount;
		}, [motionBlurAmount]);

		useEffect(() => {
			cursorTelemetryRef.current = cursorTelemetry;
		}, [cursorTelemetry]);

		useEffect(() => {
			showCursorRef.current = showCursor;
		}, [showCursor]);

		useEffect(() => {
			hasNativeCursorRecordingRef.current = hasNativeCursorRecording;
		}, [hasNativeCursorRecording]);

		useEffect(() => {
			cursorRecordingDataRef.current = cursorRecordingData;
			resetNativeCursorSmoothingState(nativeCursorSmoothingStateRef.current);
			resetNativeCursorMotionBlurState(nativeCursorMotionBlurStateRef.current);
		}, [cursorRecordingData]);

		useEffect(() => {
			cropRegionRef.current = cropRegion;
		}, [cropRegion]);

		useEffect(() => {
			cursorSizeRef.current = cursorSize;
		}, [cursorSize]);

		useEffect(() => {
			cursorSmoothingRef.current = cursorSmoothing;
		}, [cursorSmoothing]);

		useEffect(() => {
			cursorMotionBlurRef.current = cursorMotionBlur;
		}, [cursorMotionBlur]);

		useEffect(() => {
			cursorClickBounceRef.current = cursorClickBounce;
		}, [cursorClickBounce]);

		useEffect(() => {
			cursorClipToBoundsRef.current = cursorClipToBounds;
		}, [cursorClipToBounds]);

		useEffect(() => {
			isPreviewingZoomRef.current = isPreviewingZoom;
		}, [isPreviewingZoom]);

		// Sync cursor overlay config when settings change
		useEffect(() => {
			const overlay = cursorOverlayRef.current;
			if (!overlay) return;
			overlay.setDotRadius(DEFAULT_CURSOR_CONFIG.dotRadius * cursorSize);
			overlay.setSmoothingFactor(cursorSmoothing);
			overlay.setMotionBlur(cursorMotionBlur);
			overlay.setClickBounce(cursorClickBounce);
			overlay.reset();
		}, [cursorSize, cursorSmoothing, cursorMotionBlur, cursorClickBounce]);

		useEffect(() => {
			onTimeUpdateRef.current = onTimeUpdate;
		}, [onTimeUpdate]);

		useEffect(() => {
			onPlayStateChangeRef.current = onPlayStateChange;
		}, [onPlayStateChange]);

		useEffect(() => {
			if (!pixiReady || !videoReady) return;
			const el = overlayRef.current;
			if (!el) return;

			// Seed immediately so overlays never start at 800×600
			setOverlaySize({ width: el.clientWidth, height: el.clientHeight });

			const observer = new ResizeObserver((entries) => {
				if (!entries[0]) return;
				const { width, height } = entries[0].contentRect;
				setOverlaySize((prev) => {
					if (prev.width === width && prev.height === height) return prev;
					return { width, height };
				});
			});

			observer.observe(el);
			return () => observer.disconnect();
		}, [pixiReady, videoReady]);

		useEffect(() => {
			if (!pixiReady || !videoReady) return;
			const container = containerRef.current;
			if (!container) return;

			if (typeof ResizeObserver === "undefined") {
				return;
			}

			const observer = new ResizeObserver(() => {
				layoutVideoContent();
			});

			observer.observe(container);
			return () => {
				observer.disconnect();
			};
		}, [pixiReady, videoReady, layoutVideoContent]);

		// Drop the PIXI canvas resolution to 1.0 while scrubbing (the user is
		// navigating, not previewing) and restore native DPR on play/idle so the
		// preview stays faithful. Mutating renderer.resolution per-frame would
		// thrash texture uploads; we only do it on scrub-state transitions.
		useEffect(() => {
			if (!pixiReady) return;
			const app = appRef.current;
			const container = containerRef.current;
			if (!app || !container) return;

			const targetResolution = isScrubbing ? 1 : window.devicePixelRatio || 1;
			if (app.renderer.resolution === targetResolution) return;

			app.renderer.resolution = targetResolution;
			app.renderer.resize(container.clientWidth, container.clientHeight);
			layoutVideoContentRef.current?.();
		}, [isScrubbing, pixiReady]);

		useEffect(() => {
			if (!pixiReady || !videoReady) return;
			updateOverlayForRegion(selectedZoom);
		}, [selectedZoom, pixiReady, videoReady, updateOverlayForRegion]);

		useEffect(() => {
			if (!pixiReady || !videoReady) return;
			const overlayEl = overlayElement;
			if (!overlayEl) return;
			if (!selectedZoom) {
				overlayEl.style.cursor = "default";
				overlayEl.style.pointerEvents = "none";
				return;
			}
			overlayEl.style.cursor = isPlaying ? "not-allowed" : "grab";
			overlayEl.style.pointerEvents = isPlaying ? "none" : "auto";
		}, [selectedZoom, isPlaying, pixiReady, videoReady, overlayElement]);

		useEffect(() => {
			const overlayEl = overlayElement;
			if (!overlayEl) return;

			const updateOverlaySize = () => {
				const width = overlayEl.clientWidth || 800;
				const height = overlayEl.clientHeight || 600;
				setOverlaySize((prev) => {
					if (prev.width === width && prev.height === height) return prev;
					return { width, height };
				});
			};

			updateOverlaySize();

			if (typeof ResizeObserver !== "undefined") {
				const observer = new ResizeObserver(() => {
					updateOverlaySize();
				});
				observer.observe(overlayEl);
				return () => observer.disconnect();
			}

			window.addEventListener("resize", updateOverlaySize);
			return () => window.removeEventListener("resize", updateOverlaySize);
		}, [overlayElement]);

		useEffect(() => {
			const container = containerRef.current;
			if (!container) return;

			let mounted = true;
			let app: Application | null = null;

			(async () => {
				let cursorOverlayEnabled = true;
				try {
					await preloadCursorAssets();
				} catch {
					cursorOverlayEnabled = false;
				}

				app = new Application();

				await app.init({
					width: container.clientWidth,
					height: container.clientHeight,
					backgroundAlpha: 0,
					antialias: true,
					resolution: window.devicePixelRatio || 1,
					autoDensity: true,
				});

				app.ticker.maxFPS = 60;

				if (!mounted) {
					app.destroy(true, {
						children: true,
						texture: true,
						textureSource: true,
					});
					return;
				}

				appRef.current = app;
				container.appendChild(app.canvas);

				// Camera container - this will be scaled/positioned for zoom
				const cameraContainer = new Container();
				cameraContainerRef.current = cameraContainer;
				app.stage.addChild(cameraContainer);

				// Video container - holds the masked video sprite
				const videoContainer = new Container();
				videoContainerRef.current = videoContainer;
				cameraContainer.addChild(videoContainer);

				// Cursor overlay - rendered above the masked video
				if (cursorOverlayEnabled) {
					const cursorOverlay = new PixiCursorOverlay({
						dotRadius: DEFAULT_CURSOR_CONFIG.dotRadius * cursorSizeRef.current,
						smoothingFactor: cursorSmoothingRef.current,
						motionBlur: cursorMotionBlurRef.current,
						clickBounce: cursorClickBounceRef.current,
					});
					cursorOverlayRef.current = cursorOverlay;
				}

				setPixiReady(true);
			})();

			return () => {
				mounted = false;
				setPixiReady(false);
				if (cursorOverlayRef.current) {
					cursorOverlayRef.current.destroy();
					cursorOverlayRef.current = null;
				}
				nativeCursorSpriteRef.current = null;
				nativeCursorTextureIdRef.current = null;
				nativeCursorImageIdRef.current = null;
				if (app && app.renderer) {
					app.destroy(true, {
						children: true,
						texture: true,
						textureSource: true,
					});
				}
				appRef.current = null;
				cameraContainerRef.current = null;
				videoContainerRef.current = null;
				videoSpriteRef.current = null;
			};
		}, []);

		useEffect(() => {
			if (!videoPath) {
				lastResolvedDurationRef.current = null;
				isResolvingDurationRef.current = false;
				setVideoReady(false);
				setSupplementalAudioPath(null);
				return;
			}

			let cancelled = false;
			window.electronAPI
				?.preparePreviewAudioTrack?.(videoPath)
				.then((result) => {
					if (!cancelled) {
						setSupplementalAudioPath(result.success ? (result.path ?? null) : null);
					}
				})
				.catch(() => {
					if (!cancelled) {
						setSupplementalAudioPath(null);
					}
				});

			const video = videoRef.current;
			if (!video) {
				return () => {
					cancelled = true;
				};
			}
			video.pause();
			video.currentTime = 0;
			allowPlaybackRef.current = false;
			lockedVideoDimensionsRef.current = null;
			lastResolvedDurationRef.current = null;
			isResolvingDurationRef.current = false;
			if (durationResolutionTimeoutRef.current) {
				clearTimeout(durationResolutionTimeoutRef.current);
				durationResolutionTimeoutRef.current = null;
			}
			setVideoReady(false);
			if (videoReadyRafRef.current) {
				cancelAnimationFrame(videoReadyRafRef.current);
				videoReadyRafRef.current = null;
			}
			video.load();

			return () => {
				cancelled = true;
			};
		}, [videoPath]);

		useEffect(() => {
			const video = videoRef.current;
			const supplementalAudio = supplementalAudioRef.current;
			if (!video || !supplementalAudio || !supplementalAudioPath) {
				return;
			}

			const activeSpeedRegion =
				speedRegions.find(
					(region) => currentTime * 1000 >= region.startMs && currentTime * 1000 < region.endMs,
				) ?? null;
			supplementalAudio.playbackRate = activeSpeedRegion ? activeSpeedRegion.speed : 1;

			if (!isPlaying) {
				supplementalAudio.pause();
				if (Math.abs(supplementalAudio.currentTime - currentTime) > 0.05) {
					supplementalAudio.currentTime = currentTime;
				}
				return;
			}

			if (Math.abs(supplementalAudio.currentTime - video.currentTime) > 0.15) {
				supplementalAudio.currentTime = video.currentTime;
			}

			supplementalAudio.play().catch(() => {
				// Keep video playback running even if supplemental preview audio is unavailable.
			});
		}, [currentTime, isPlaying, speedRegions, supplementalAudioPath]);

		useEffect(() => {
			if (!pixiReady || !videoReady) return;

			const video = videoRef.current;
			const app = appRef.current;
			const videoContainer = videoContainerRef.current;

			if (!video || !app || !videoContainer) return;
			if (video.videoWidth === 0 || video.videoHeight === 0) return;

			const source = VideoSource.from(video);
			if ("autoPlay" in source) {
				(source as { autoPlay?: boolean }).autoPlay = false;
			}
			if ("autoUpdate" in source) {
				(source as { autoUpdate?: boolean }).autoUpdate = true;
			}
			const videoTexture = Texture.from(source);

			const videoSprite = new Sprite(videoTexture);
			videoSpriteRef.current = videoSprite;

			const maskGraphics = new Graphics();
			videoContainer.addChild(videoSprite);
			videoContainer.addChild(maskGraphics);
			videoContainer.mask = maskGraphics;
			maskGraphicsRef.current = maskGraphics;
			const nativeCursorSprite = new Sprite(Texture.EMPTY);
			nativeCursorSprite.visible = false;
			nativeCursorSprite.eventMode = "none";
			nativeCursorSpriteRef.current = nativeCursorSprite;
			if (cursorOverlayRef.current) {
				videoContainer.addChild(cursorOverlayRef.current.container);
			}

			videoContainer.addChild(nativeCursorSprite);

			animationStateRef.current = {
				scale: 1,
				focusX: DEFAULT_FOCUS.cx,
				focusY: DEFAULT_FOCUS.cy,
				progress: 0,
				x: 0,
				y: 0,
				appliedScale: 1,
			};

			const blurFilter = new BlurFilter();
			blurFilter.quality = 3;
			blurFilter.resolution = app.renderer.resolution;
			blurFilter.blur = 0;
			const motionBlurFilter = new MotionBlurFilter([0, 0], 5, 0);
			blurFilterRef.current = blurFilter;
			motionBlurFilterRef.current = motionBlurFilter;

			layoutVideoContentRef.current?.();
			video.pause();

			const { handlePlay, handlePause, handleSeeked, handleSeeking } = createVideoEventHandlers({
				video,
				isSeekingRef,
				isPlayingRef,
				allowPlaybackRef,
				currentTimeRef,
				timeUpdateAnimationRef,
				onPlayStateChange: (playing) => onPlayStateChangeRef.current(playing),
				onTimeUpdate: (time) => onTimeUpdateRef.current(time),
				trimRegionsRef,
				speedRegionsRef,
				isScrubbingRef,
				scrubEndTimerRef,
				onScrubChange: (scrubbing) => setIsScrubbing(scrubbing),
			});

			video.addEventListener("play", handlePlay);
			video.addEventListener("pause", handlePause);
			video.addEventListener("ended", handlePause);
			video.addEventListener("seeked", handleSeeked);
			video.addEventListener("seeking", handleSeeking);

			return () => {
				video.removeEventListener("play", handlePlay);
				video.removeEventListener("pause", handlePause);
				video.removeEventListener("ended", handlePause);
				video.removeEventListener("seeked", handleSeeked);
				video.removeEventListener("seeking", handleSeeking);

				if (timeUpdateAnimationRef.current) {
					cancelAnimationFrame(timeUpdateAnimationRef.current);
				}

				if (videoSprite) {
					videoContainer.removeChild(videoSprite);
					videoSprite.destroy();
				}
				if (maskGraphics) {
					videoContainer.removeChild(maskGraphics);
					maskGraphics.destroy();
				}
				if (nativeCursorSpriteRef.current) {
					videoContainer.removeChild(nativeCursorSpriteRef.current);
					nativeCursorSpriteRef.current.destroy();
					nativeCursorSpriteRef.current = null;
					nativeCursorTextureIdRef.current = null;
				}
				videoContainer.mask = null;
				maskGraphicsRef.current = null;
				if (blurFilterRef.current) {
					videoContainer.filters = null;
					blurFilterRef.current.destroy();
					blurFilterRef.current = null;
				}
				if (motionBlurFilterRef.current) {
					motionBlurFilterRef.current.destroy();
					motionBlurFilterRef.current = null;
				}
				videoTexture.destroy(true);

				videoSpriteRef.current = null;
			};
		}, [pixiReady, videoReady]);

		useEffect(() => {
			if (!pixiReady || !videoReady) return;

			const app = appRef.current;
			const videoSprite = videoSpriteRef.current;
			const videoContainer = videoContainerRef.current;
			if (!app || !videoSprite || !videoContainer) return;

			const applyTransformFn = (
				transform: { scale: number; x: number; y: number },
				targetFocus: ZoomFocus,
				motionIntensity: number,
				motionVector: { x: number; y: number },
				layerId?: string,
			) => {
				const cameraContainer = cameraContainerRef.current;
				if (!cameraContainer) return;

				const state = animationStateRef.current;

				const appliedTransform = applyZoomTransform({
					cameraContainer,
					blurFilter: blurFilterRef.current,
					motionBlurFilter: motionBlurFilterRef.current,
					stageSize: stageSizeRef.current,
					baseMask: baseMaskRef.current,
					zoomScale: state.scale,
					zoomProgress: state.progress,
					focusX: targetFocus.cx,
					focusY: targetFocus.cy,
					motionIntensity,
					motionVector,
					isPlaying: isPlayingRef.current,
					motionBlurAmount: motionBlurAmountRef.current,
					transformOverride: transform,
					motionBlurState: motionBlurStateRef.current,
					frameTimeMs: performance.now(),
					layerId,
					layerRects: layerRectsRef.current,
				});

				state.x = appliedTransform.x;
				state.y = appliedTransform.y;
				state.appliedScale = appliedTransform.scale;
			};

			let lastMotionBlurActive: boolean | null = null;
			let lastTransformIsIdentity = true;
			let lastPerspectiveValue = 0;
			const ticker = () => {
				const { region, strength, blendedScale, rotation3D, transition } = findDominantRegion(
					zoomRegionsRef.current,
					currentTimeRef.current,
					{
						connectZooms: true,
						cursorTelemetry: cursorTelemetryRef.current,
					},
				);

				const defaultFocus = DEFAULT_FOCUS;
				let targetScaleFactor = 1;
				let targetFocus = defaultFocus;
				let targetProgress = 0;

				// If a zoom is selected but video is not playing, show default unzoomed view
				const selectedId = selectedZoomIdRef.current;
				const hasSelectedZoom = selectedId !== null;
				const shouldShowUnzoomedView =
					hasSelectedZoom && !isPlayingRef.current && !isPreviewingZoomRef.current;

				if (region && strength > 0 && !shouldShowUnzoomedView) {
					const zoomScale = blendedScale ?? ZOOM_DEPTH_SCALES[region.depth];
					const regionFocus = region.focus;

					targetScaleFactor = zoomScale;
					targetFocus = regionFocus;
					targetProgress = strength;

					// Apply adaptive smoothing for auto-follow mode
					if (region.focusMode === "auto" && !transition) {
						const raw = targetFocus;
						const isZoomingIn =
							targetProgress < 0.999 && targetProgress >= prevTargetProgressRef.current;
						if (targetProgress >= 0.999) {
							// Full zoom: adaptive smoothing — moves faster when far, decelerates when close
							const prev = smoothedAutoFocusRef.current ?? raw;
							const factor = adaptiveSmoothFactor(
								raw,
								prev,
								AUTO_FOLLOW_SMOOTHING_FACTOR,
								AUTO_FOLLOW_SMOOTHING_FACTOR_MAX,
								AUTO_FOLLOW_RAMP_DISTANCE,
							);
							const smoothed = smoothCursorFocus(raw, prev, factor);
							smoothedAutoFocusRef.current = smoothed;
							targetFocus = smoothed;
						} else if (isZoomingIn) {
							// Zoom-in: track cursor directly so zoom always aims at current cursor
							// position; keep ref in sync to avoid snap when full-zoom begins
							smoothedAutoFocusRef.current = raw;
						} else {
							// Zoom-out: keep smoothing for continuity — avoids snap at zoom-out start
							const prev = smoothedAutoFocusRef.current ?? raw;
							const factor = adaptiveSmoothFactor(
								raw,
								prev,
								AUTO_FOLLOW_SMOOTHING_FACTOR,
								AUTO_FOLLOW_SMOOTHING_FACTOR_MAX,
								AUTO_FOLLOW_RAMP_DISTANCE,
							);
							const smoothed = smoothCursorFocus(raw, prev, factor);
							smoothedAutoFocusRef.current = smoothed;
							targetFocus = smoothed;
						}
					} else if (region.focusMode !== "auto") {
						smoothedAutoFocusRef.current = null;
					}
					prevTargetProgressRef.current = targetProgress;

					// Handle connected zoom transitions (pan between adjacent zoom regions)
					if (transition) {
						// Limitation: findDominantRegion only carries the next region's
						// layerId across the transition, so a connected pan that crosses
						// from a layer-bound zoom into a stage-global zoom (or between
						// two different layers) interpolates both endpoints against the
						// next region's layer. Acceptable trade-off given how rare such
						// mixed-target pairs are in practice.
						const startTransform = computeZoomTransform({
							stageSize: stageSizeRef.current,
							baseMask: baseMaskRef.current,
							zoomScale: transition.startScale,
							zoomProgress: 1,
							focusX: transition.startFocus.cx,
							focusY: transition.startFocus.cy,
							layerId: region?.layerId,
							layerRects: layerRectsRef.current,
						});
						const endTransform = computeZoomTransform({
							stageSize: stageSizeRef.current,
							baseMask: baseMaskRef.current,
							zoomScale: transition.endScale,
							zoomProgress: 1,
							focusX: transition.endFocus.cx,
							focusY: transition.endFocus.cy,
							layerId: region?.layerId,
							layerRects: layerRectsRef.current,
						});

						const interpolatedTransform = {
							scale:
								startTransform.scale +
								(endTransform.scale - startTransform.scale) * transition.progress,
							x: startTransform.x + (endTransform.x - startTransform.x) * transition.progress,
							y: startTransform.y + (endTransform.y - startTransform.y) * transition.progress,
						};

						targetScaleFactor = interpolatedTransform.scale;
						targetFocus = computeFocusFromTransform({
							stageSize: stageSizeRef.current,
							baseMask: baseMaskRef.current,
							zoomScale: interpolatedTransform.scale,
							x: interpolatedTransform.x,
							y: interpolatedTransform.y,
						});
						targetProgress = 1;
					}
				}

				const state = animationStateRef.current;
				const prevScale = state.appliedScale;
				const prevX = state.x;
				const prevY = state.y;

				state.scale = targetScaleFactor;
				state.focusX = targetFocus.cx;
				state.focusY = targetFocus.cy;
				state.progress = targetProgress;

				// During a connected transition the targetFocus we already
				// stored is the *stage-normalized* focus that
				// computeFocusFromTransform reconstructed from the
				// interpolated camera transform. Re-mapping it through the
				// layer rect would double-apply the layer offset, so skip the
				// layerId here while transition is active.
				const effectiveLayerId = transition ? undefined : region?.layerId;
				const projectedTransform = computeZoomTransform({
					stageSize: stageSizeRef.current,
					baseMask: baseMaskRef.current,
					zoomScale: state.scale,
					zoomProgress: state.progress,
					focusX: state.focusX,
					focusY: state.focusY,
					layerId: effectiveLayerId,
					layerRects: layerRectsRef.current,
				});

				const appliedScale =
					Math.abs(projectedTransform.scale - prevScale) < ZOOM_SCALE_DEADZONE
						? projectedTransform.scale
						: projectedTransform.scale;
				const appliedX =
					Math.abs(projectedTransform.x - prevX) < ZOOM_TRANSLATION_DEADZONE_PX
						? projectedTransform.x
						: projectedTransform.x;
				const appliedY =
					Math.abs(projectedTransform.y - prevY) < ZOOM_TRANSLATION_DEADZONE_PX
						? projectedTransform.y
						: projectedTransform.y;

				const motionIntensity = Math.max(
					Math.abs(appliedScale - prevScale),
					Math.abs(appliedX - prevX) / Math.max(1, stageSizeRef.current.width),
					Math.abs(appliedY - prevY) / Math.max(1, stageSizeRef.current.height),
				);

				const motionVector = {
					x: appliedX - prevX,
					y: appliedY - prevY,
				};

				applyTransformFn(
					{ scale: appliedScale, x: appliedX, y: appliedY },
					targetFocus,
					motionIntensity,
					motionVector,
					effectiveLayerId,
				);

				const isMotionBlurActive =
					(motionBlurAmountRef.current || 0) > 0 && isPlayingRef.current && !isScrubbingRef.current;

				if (isMotionBlurActive !== lastMotionBlurActive && videoContainerRef.current) {
					if (isMotionBlurActive) {
						if (blurFilterRef.current && motionBlurFilterRef.current) {
							videoContainerRef.current.filters = [
								blurFilterRef.current,
								motionBlurFilterRef.current,
							];
							lastMotionBlurActive = true;
						}
					} else {
						videoContainerRef.current.filters = null;
						lastMotionBlurActive = false;
					}
				}

				// Update cursor overlay
				const cursorOverlay = cursorOverlayRef.current;
				if (cursorOverlay) {
					const timeMs = currentTimeRef.current; // already in ms
					cursorOverlay.update(
						cursorTelemetryRef.current,
						timeMs,
						baseMaskRef.current,
						showCursorRef.current && !hasNativeCursorRecordingRef.current,
						!isPlayingRef.current || isSeekingRef.current,
					);
				}

				// Keep the native cursor preview in the same transformed coordinate space as PIXI.
				const nativeCursorSprite = nativeCursorSpriteRef.current;
				const nativeCursorImage = nativeCursorImageRef.current;
				const hideNativeCursorPreview = () => {
					if (nativeCursorSprite) {
						nativeCursorSprite.visible = false;
					}
					if (nativeCursorImage) {
						nativeCursorImage.style.display = "none";
						nativeCursorImage.style.filter = "none";
					}
					if (nativeCursorClipRef.current) {
						nativeCursorClipRef.current.style.clipPath = "";
					}
					resetNativeCursorSmoothingState(nativeCursorSmoothingStateRef.current);
					resetNativeCursorMotionBlurState(nativeCursorMotionBlurStateRef.current);
				};
				if (nativeCursorImage) {
					if (hasNativeCursorRecordingRef.current && showCursorRef.current) {
						const timeMs = currentTimeRef.current; // already in ms
						const frame = resolveInterpolatedNativeCursorFrame(
							cursorRecordingDataRef.current,
							timeMs,
						);
						if (frame) {
							const displaySample = smoothNativeCursorSample({
								forceSnap: !isPlayingRef.current || isSeekingRef.current,
								sample: frame.sample,
								smoothing: cursorSmoothingRef.current,
								state: nativeCursorSmoothingStateRef.current,
								timeMs,
							});
							const cameraContainer = cameraContainerRef.current;
							const videoContainer = videoContainerRef.current;
							const cropRegionValue = cropRegionRef.current ?? { x: 0, y: 0, width: 1, height: 1 };
							const projectedLocalPoint = projectNativeCursorToLocal({
								cropRegion: cropRegionValue,
								maskRect: baseMaskRef.current,
								sample: displaySample,
							});
							const projectedStagePoint =
								cameraContainer && videoContainer
									? projectNativeCursorToStage({
											cameraContainer,
											cropRegion: cropRegionValue,
											maskRect: baseMaskRef.current,
											videoContainerPosition: {
												x: videoContainer.x,
												y: videoContainer.y,
											},
											sample: displaySample,
										})
									: null;
							if (projectedLocalPoint && projectedStagePoint) {
								// Pass deviceScaleFactor=1 — asset.scaleFactor already encodes DPR.
								// Size is normalized below so preview matches export proportionally.
								const renderAsset = resolveNativeCursorRenderAsset(frame.asset, 1, displaySample);
								const bounceProgress = getNativeCursorClickBounceProgress(
									cursorRecordingDataRef.current,
									timeMs,
								);
								const scale =
									Math.max(0, cursorSizeRef.current) *
									getNativeCursorClickBounceScale(cursorClickBounceRef.current, bounceProgress);
								// Normalize cursor size to the displayed video width so the cursor
								// appears at the same fraction of the video in both preview and export.
								const crop = cropRegionRef.current ?? { x: 0, y: 0, width: 1, height: 1 };
								const croppedVideoWidth = (videoRef.current?.videoWidth ?? 0) * crop.width;
								const sizeNorm =
									croppedVideoWidth > 0 ? baseMaskRef.current.width / croppedVideoWidth : 1;
								const transformedScale = scale * Math.abs(cameraContainer?.scale.x || 1) * sizeNorm;
								const blurPx =
									!isPlayingRef.current || isSeekingRef.current
										? 0
										: getNativeCursorMotionBlurPx({
												motionBlur: cursorMotionBlurRef.current,
												point: projectedStagePoint,
												state: nativeCursorMotionBlurStateRef.current,
												timeMs,
											});
								if (nativeCursorImageIdRef.current !== renderAsset.id) {
									nativeCursorImage.src = renderAsset.imageDataUrl;
									nativeCursorImageIdRef.current = renderAsset.id;
								}
								nativeCursorImage.style.display = "block";
								// Update clip-path on nativeCursorClipRef to the camera-aware video boundary.
								// clip-path works correctly here because nativeCursorClipRef is outside preserve-3d.
								// When cursorClipToBounds is off, allow the cursor to overflow the canvas.
								if (nativeCursorClipRef.current) {
									if (!cursorClipToBoundsRef.current) {
										nativeCursorClipRef.current.style.clipPath = "none";
									} else {
										const mask = baseMaskRef.current;
										const stage = stageSizeRef.current;
										const br = borderRadiusRef.current;
										const s = cameraContainer ? Math.abs(cameraContainer.scale.x) : 1;
										const camX = cameraContainer ? cameraContainer.position.x : 0;
										const camY = cameraContainer ? cameraContainer.position.y : 0;
										const clipLeft = camX + s * mask.x;
										const clipTop = camY + s * mask.y;
										const clipRight = camX + s * (mask.x + mask.width);
										const clipBottom = camY + s * (mask.y + mask.height);
										nativeCursorClipRef.current.style.clipPath = `inset(${clipTop}px ${stage.width - clipRight}px ${stage.height - clipBottom}px ${clipLeft}px round ${br * s}px)`;
									}
								}
								nativeCursorImage.style.width = `${renderAsset.width * transformedScale}px`;
								nativeCursorImage.style.height = `${renderAsset.height * transformedScale}px`;
								nativeCursorImage.style.filter =
									blurPx > 0 ? `blur(${blurPx.toFixed(2)}px)` : "none";
								// translate3d is relative to nativeCursorClipRef (absolute inset-0 = stage origin).
								// projectedStagePoint.x is the stage-space cursor position — no offset needed.
								nativeCursorImage.style.transform = `translate3d(${
									projectedStagePoint.x - renderAsset.hotspotX * transformedScale
								}px, ${projectedStagePoint.y - renderAsset.hotspotY * transformedScale}px, 0)`;
								if (nativeCursorSprite) {
									nativeCursorSprite.visible = false;
									if (nativeCursorTextureIdRef.current !== renderAsset.id) {
										nativeCursorSprite.texture = Texture.from(renderAsset.imageDataUrl);
										nativeCursorTextureIdRef.current = renderAsset.id;
									}
									nativeCursorSprite.position.set(
										projectedLocalPoint.x - renderAsset.hotspotX * scale,
										projectedLocalPoint.y - renderAsset.hotspotY * scale,
									);
									nativeCursorSprite.width = renderAsset.width * scale;
									nativeCursorSprite.height = renderAsset.height * scale;
								}
							} else {
								hideNativeCursorPreview();
							}
						} else {
							hideNativeCursorPreview();
						}
					} else {
						hideNativeCursorPreview();
					}
				} else {
					hideNativeCursorPreview();
				}

				const composite3D = composite3DRef.current;
				const outerWrapper = outerWrapperRef.current;
				if (composite3D && outerWrapper) {
					const effectiveRotation =
						region && targetProgress > 0 && !shouldShowUnzoomedView
							? lerpRotation3D(DEFAULT_ROTATION_3D, rotation3D, targetProgress)
							: DEFAULT_ROTATION_3D;
					const isIdentity = isRotation3DIdentity(effectiveRotation);
					if (isIdentity) {
						if (!lastTransformIsIdentity) {
							composite3D.style.transform = "";
							composite3D.style.willChange = "auto";
							lastTransformIsIdentity = true;
						}
						if (nativeCursorClipRef.current) {
							nativeCursorClipRef.current.style.transform = "";
						}
						if (lastPerspectiveValue !== 0) {
							outerWrapper.style.perspective = "";
							lastPerspectiveValue = 0;
						}
					} else {
						const wrapperW = outerWrapper.clientWidth || 1;
						const wrapperH = outerWrapper.clientHeight || 1;
						const persp = rotation3DPerspective(wrapperW, wrapperH);
						const containScale = computeRotation3DContainScale(
							effectiveRotation,
							wrapperW,
							wrapperH,
							persp,
						);
						composite3D.style.transform = `scale(${containScale}) rotateX(${effectiveRotation.rotationX}deg) rotateY(${effectiveRotation.rotationY}deg) rotateZ(${effectiveRotation.rotationZ}deg)`;
						composite3D.style.willChange = "transform";
						if (nativeCursorClipRef.current) {
							nativeCursorClipRef.current.style.transform = composite3D.style.transform;
						}
						lastTransformIsIdentity = false;
						if (persp !== lastPerspectiveValue) {
							outerWrapper.style.perspective = `${persp}px`;
							lastPerspectiveValue = persp;
						}
					}
				}
			};

			app.ticker.add(ticker);
			return () => {
				if (app && app.ticker) {
					app.ticker.remove(ticker);
				}
			};
		}, [pixiReady, videoReady]);

		const handleLoadedMetadata = (e: React.SyntheticEvent<HTMLVideoElement, Event>) => {
			const video = e.currentTarget;
			enableAllPreviewAudioTracks(video);
			const hasResolvedDuration = syncResolvedDuration(video);
			if (!hasResolvedDuration) {
				forceResolveDuration(video);
			} else {
				video.currentTime = 0;
			}
			video.pause();
			allowPlaybackRef.current = false;
			currentTimeRef.current = 0;

			if (videoReadyRafRef.current) {
				cancelAnimationFrame(videoReadyRafRef.current);
				videoReadyRafRef.current = null;
			}

			const waitForRenderableFrame = () => {
				const hasDimensions = video.videoWidth > 0 && video.videoHeight > 0;
				const hasData = video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
				if (!syncResolvedDuration(video)) {
					forceResolveDuration(video);
				}
				if (hasDimensions && hasData) {
					videoReadyRafRef.current = null;
					setVideoReady(true);
					return;
				}
				videoReadyRafRef.current = requestAnimationFrame(waitForRenderableFrame);
			};

			videoReadyRafRef.current = requestAnimationFrame(waitForRenderableFrame);
		};

		const resolvedWallpaper = useMemo<string | null>(() => {
			const source = wallpaper || DEFAULT_WALLPAPER;
			const classified = classifyWallpaper(source);
			if (classified.kind !== "image") return classified.value;
			try {
				return resolveImageWallpaperUrl(classified.path);
			} catch (err) {
				console.warn("[VideoPlayback] wallpaper resolve failed:", err);
				return null;
			}
		}, [wallpaper]);
		const webcamCssBoxShadow = useMemo(
			() => getWebcamLayoutCssBoxShadow(webcamLayoutPreset),
			[webcamLayoutPreset],
		);

		useEffect(() => {
			const webcamVideo = webcamVideoRef.current;
			if (!webcamVideo || !webcamVideoPath) {
				setWebcamDimensions(null);
				return;
			}

			const handleLoadedMetadata = () => {
				if (webcamVideo.videoWidth > 0 && webcamVideo.videoHeight > 0) {
					setWebcamDimensions({
						width: webcamVideo.videoWidth,
						height: webcamVideo.videoHeight,
					});
				}
			};

			webcamVideo.addEventListener("loadedmetadata", handleLoadedMetadata);
			handleLoadedMetadata();
			return () => {
				webcamVideo.removeEventListener("loadedmetadata", handleLoadedMetadata);
			};
		}, [webcamVideoPath]);

		useEffect(() => {
			const webcamVideo = webcamVideoRef.current;
			if (!webcamVideo || !webcamVideoPath) {
				return;
			}

			const activeSpeedRegion =
				speedRegions.find(
					(region) => currentTime * 1000 >= region.startMs && currentTime * 1000 < region.endMs,
				) ?? null;
			webcamVideo.playbackRate = activeSpeedRegion ? activeSpeedRegion.speed : 1;

			if (!isPlaying) {
				webcamVideo.pause();
				if (Math.abs(webcamVideo.currentTime - currentTime) > 0.05) {
					webcamVideo.currentTime = currentTime;
				}
				return;
			}

			if (Math.abs(webcamVideo.currentTime - currentTime) > 0.15) {
				webcamVideo.currentTime = currentTime;
			}

			webcamVideo.play().catch(() => {
				// Ignore webcam autoplay restoration failures.
			});
		}, [currentTime, isPlaying, speedRegions, webcamVideoPath]);

		useEffect(() => {
			const webcamVideo = webcamVideoRef.current;
			if (!webcamVideo || !webcamVideoPath) {
				return;
			}

			webcamVideo.pause();
			webcamVideo.currentTime = 0;
		}, [webcamVideoPath]);

		useEffect(() => {
			return () => {
				if (videoReadyRafRef.current) {
					cancelAnimationFrame(videoReadyRafRef.current);
					videoReadyRafRef.current = null;
				}
				if (scrubEndTimerRef.current !== null) {
					window.clearTimeout(scrubEndTimerRef.current);
					scrubEndTimerRef.current = null;
				}
				if (durationResolutionTimeoutRef.current) {
					clearTimeout(durationResolutionTimeoutRef.current);
					durationResolutionTimeoutRef.current = null;
				}
			};
		}, []);

		const isImageUrl = Boolean(
			resolvedWallpaper &&
				(resolvedWallpaper.startsWith("file://") ||
					resolvedWallpaper.startsWith("http") ||
					resolvedWallpaper.startsWith("/") ||
					resolvedWallpaper.startsWith("data:")),
		);
		const backgroundStyle = isImageUrl
			? { backgroundImage: `url(${resolvedWallpaper || ""})` }
			: { background: resolvedWallpaper || "" };

		// Phase 6.5: primaryTransform / enablePrimaryTile are hoisted to the
		// top of this component (see useState block above) so the
		// layoutVideoContent useCallback can list enablePrimaryTile as a dep
		// without a TDZ error. Layer 1 always renders inside the Rnd so React
		// keeps the same DOM hierarchy across single-source / multi-source
		// toggles and PixiJS doesn't re-initialize.
		const stagePxWidth = stageWrapperSize.width;
		const stagePxHeight = stageWrapperSize.height;
		const primaryStageWidthPx =
			enablePrimaryTile && primaryTransform
				? Math.max(60, primaryTransform.size.width * stagePxWidth)
				: stagePxWidth;
		const primaryStageHeightPx =
			enablePrimaryTile && primaryTransform
				? Math.max(40, primaryTransform.size.height * stagePxHeight)
				: stagePxHeight;
		const primaryStageXPx =
			enablePrimaryTile && primaryTransform
				? primaryTransform.position.cx * stagePxWidth - primaryStageWidthPx / 2
				: 0;
		const primaryStageYPx =
			enablePrimaryTile && primaryTransform
				? primaryTransform.position.cy * stagePxHeight - primaryStageHeightPx / 2
				: 0;

		return (
			<div
				ref={outerWrapperRef}
				className="relative rounded-sm overflow-hidden"
				style={{
					width: "100%",
					aspectRatio: formatAspectRatioForCSS(
						aspectRatio,
						aspectRatio === "native"
							? getNativeAspectRatioValue(
									lockedVideoDimensionsRef.current?.width || DEFAULT_SOURCE_DIMENSIONS.width,
									lockedVideoDimensionsRef.current?.height || DEFAULT_SOURCE_DIMENSIONS.height,
									cropRegion,
								)
							: undefined,
					),
				}}
			>
				{/* Background layer - always render as DOM element with blur */}
				<div
					className="absolute inset-0 bg-cover bg-center"
					style={{
						...backgroundStyle,
						filter: showBlur ? "blur(2px)" : "none",
					}}
				/>
				<Rnd
					size={{ width: primaryStageWidthPx, height: primaryStageHeightPx }}
					position={{ x: primaryStageXPx, y: primaryStageYPx }}
					bounds="parent"
					disableDragging={!enablePrimaryTile}
					enableResizing={enablePrimaryTile}
					// Phase 6.5 fix: don't capture pointerdown that originated
					// from annotation / blur tiles (they have their own Rnd
					// nested inside). Without this cancel selector, dragging
					// an annotation also drags the primary tile underneath.
					cancel=".annotation-overlay-tile"
					// Phase 6.5: preserve the video's aspect ratio while
					// resizing, matching the behavior of additional layer
					// tiles below. The locked ratio tracks the current size,
					// which after the baseMask sync equals the rendered
					// frame's aspect.
					lockAspectRatio={
						enablePrimaryTile && primaryStageHeightPx > 0
							? primaryStageWidthPx / primaryStageHeightPx
							: false
					}
					onDrag={(_e, d) => {
						if (!enablePrimaryTile || !primaryLayerId || !onLayerTransformUpdate) return;
						const cx = (d.x + primaryStageWidthPx / 2) / stagePxWidth;
						const cy = (d.y + primaryStageHeightPx / 2) / stagePxHeight;
						onLayerTransformUpdate(primaryLayerId, {
							position: {
								cx: Math.max(0, Math.min(1, cx)),
								cy: Math.max(0, Math.min(1, cy)),
							},
						});
					}}
					onDragStop={() => {
						if (enablePrimaryTile) onLayerTransformCommit?.();
					}}
					onResize={(_e, _dir, ref, _delta, position) => {
						if (!enablePrimaryTile || !primaryLayerId || !onLayerTransformUpdate) return;
						const w = ref.offsetWidth;
						const h = ref.offsetHeight;
						const cx = (position.x + w / 2) / stagePxWidth;
						const cy = (position.y + h / 2) / stagePxHeight;
						onLayerTransformUpdate(primaryLayerId, {
							position: {
								cx: Math.max(0, Math.min(1, cx)),
								cy: Math.max(0, Math.min(1, cy)),
							},
							size: {
								width: Math.max(0.05, Math.min(1, w / stagePxWidth)),
								height: Math.max(0.05, Math.min(1, h / stagePxHeight)),
							},
						});
					}}
					onResizeStop={() => {
						if (enablePrimaryTile) onLayerTransformCommit?.();
					}}
					style={
						enablePrimaryTile
							? {
									// Phase 8 z-order: drive Layer 1's zIndex
									// from its layerTransform.zOrder so the
									// user-facing Layer order UI in
									// SettingsPanel can swap it with
									// additional layers. MultiLayerOverlay
									// dropped its container zIndex so all
									// layers share the outerWrapperRef
									// stacking context — direct comparison
									// works.
									zIndex: 10 + (primaryTransform?.zOrder ?? 100),
									border: "1px solid rgba(255,255,255,0.3)",
									borderRadius: 6,
									// overflow stays "visible" so annotation /
									// blur / zoom focus tiles can extend past
									// Layer 1's box and overlap Layer 2/3. The
									// PixiJS canvas is rectangular and stays
									// inside its own bounds, so this doesn't
									// break the video render.
									boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
									cursor: "move",
								}
							: { zIndex: 1 }
					}
				>
					{enablePrimaryTile && (
						<div
							className="pointer-events-none absolute left-1 top-1 rounded bg-black/60 px-1 text-[9px] font-semibold text-white"
							style={{ zIndex: 12 }}
						>
							Layer 1
						</div>
					)}
					<div
						ref={composite3DRef}
						className="absolute inset-0"
						style={{
							transformStyle: "preserve-3d",
							transformOrigin: "center center",
							// Phase 6.5: when the primary is a draggable tile, kill
							// pointer events on the content so the Rnd above
							// receives drag/resize gestures across the entire
							// tile. Internal annotation / zoom focus editing is
							// disabled in this mode (matches additional layers).
							pointerEvents: enablePrimaryTile ? "none" : "auto",
						}}
					>
						<div
							ref={containerRef}
							className="absolute inset-0"
							style={{
								filter:
									showShadow && shadowIntensity > 0
										? `drop-shadow(0 ${shadowIntensity * 12}px ${shadowIntensity * 48}px rgba(0,0,0,${shadowIntensity * 0.7})) drop-shadow(0 ${shadowIntensity * 4}px ${shadowIntensity * 16}px rgba(0,0,0,${shadowIntensity * 0.5})) drop-shadow(0 ${shadowIntensity * 2}px ${shadowIntensity * 8}px rgba(0,0,0,${shadowIntensity * 0.3}))`
										: "none",
							}}
						/>
						{webcamVideoPath &&
							(() => {
								const clipPath = getCssClipPath(webcamLayout?.maskShape ?? "rectangle");
								const useClipPath = !!clipPath;
								return (
									<div
										className="absolute"
										style={{
											left: webcamLayout?.x ?? 0,
											top: webcamLayout?.y ?? 0,
											width: webcamLayout?.width ?? 0,
											height: webcamLayout?.height ?? 0,
											zIndex: 20,
											opacity: webcamLayout ? 1 : 0,
											filter:
												useClipPath && webcamCssBoxShadow !== "none"
													? `drop-shadow(${webcamCssBoxShadow})`
													: undefined,
										}}
									>
										<video
											ref={webcamVideoRef}
											src={webcamVideoPath}
											className={`w-full h-full object-cover ${webcamLayoutPreset === "picture-in-picture" ? "cursor-grab active:cursor-grabbing" : "pointer-events-none"}`}
											style={{
												borderRadius: useClipPath ? 0 : (webcamLayout?.borderRadius ?? 0),
												clipPath: clipPath ?? undefined,
												boxShadow: useClipPath ? "none" : webcamCssBoxShadow,
												backgroundColor: "#000",
											}}
											onPointerDown={handleWebcamPointerDown}
											onPointerMove={handleWebcamPointerMove}
											onPointerUp={handleWebcamPointerUp}
											onPointerLeave={handleWebcamPointerUp}
											muted
											preload="metadata"
											playsInline
										/>
									</div>
								);
							})()}
						{/* Only render overlay after PIXI and video are fully initialized */}
						{pixiReady && videoReady && (
							<div
								ref={setOverlayRefs}
								className="absolute inset-0 select-none"
								style={{ pointerEvents: "auto", zIndex: 30 }}
								onPointerDown={handleOverlayPointerDown}
								onPointerMove={handleOverlayPointerMove}
								onPointerUp={handleOverlayPointerUp}
								onPointerLeave={handleOverlayPointerLeave}
							>
								<div
									ref={focusIndicatorRef}
									className="absolute rounded-md border border-[#34B27B]/80 bg-[#34B27B]/20 shadow-[0_0_0_1px_rgba(52,178,123,0.35)]"
									style={{ display: "none", pointerEvents: "none" }}
								/>
								{(() => {
									const filteredAnnotations = (annotationRegions || []).filter((annotation) => {
										if (
											typeof annotation.startMs !== "number" ||
											typeof annotation.endMs !== "number"
										)
											return false;

										if (annotation.id === selectedAnnotationId) return true;

										const timeMs = Math.round(currentTime * 1000);
										return timeMs >= annotation.startMs && timeMs < annotation.endMs;
									});

									const filteredBlurRegions = (blurRegions || []).filter((blurRegion) => {
										if (
											typeof blurRegion.startMs !== "number" ||
											typeof blurRegion.endMs !== "number"
										)
											return false;

										if (blurRegion.id === selectedBlurId) return true;

										const timeMs = Math.round(currentTime * 1000);
										return timeMs >= blurRegion.startMs && timeMs < blurRegion.endMs;
									});

									const sorted = [
										...filteredAnnotations.map((annotation) => ({
											kind: "annotation" as const,
											region: annotation,
										})),
										...filteredBlurRegions.map((blurRegion) => ({
											kind: "blur" as const,
											region: blurRegion,
										})),
									].sort((a, b) => a.region.zIndex - b.region.zIndex);
									const previewSnapshotCanvas =
										filteredBlurRegions.length > 0
											? (() => {
													const app = appRef.current;
													if (!app?.renderer?.extract) return null;
													try {
														return app.renderer.extract.canvas(app.stage);
													} catch {
														return null;
													}
												})()
											: null;

									// Handle click-through cycling: when clicking same annotation, cycle to next
									const handleAnnotationClick = (clickedId: string) => {
										if (!onSelectAnnotation) return;

										// If clicking on already selected annotation and there are multiple overlapping
										if (clickedId === selectedAnnotationId && filteredAnnotations.length > 1) {
											// Find current index and cycle to next
											const currentIndex = filteredAnnotations.findIndex((a) => a.id === clickedId);
											const nextIndex = (currentIndex + 1) % filteredAnnotations.length;
											onSelectAnnotation(filteredAnnotations[nextIndex].id);
										} else {
											// First click or clicking different annotation
											onSelectAnnotation(clickedId);
										}
									};

									const handleBlurClick = (clickedId: string) => {
										if (!onSelectBlur) return;

										if (clickedId === selectedBlurId && filteredBlurRegions.length > 1) {
											const currentIndex = filteredBlurRegions.findIndex((a) => a.id === clickedId);
											const nextIndex = (currentIndex + 1) % filteredBlurRegions.length;
											onSelectBlur(filteredBlurRegions[nextIndex].id);
										} else {
											onSelectBlur(clickedId);
										}
									};

									return sorted.map((item) => (
										<AnnotationOverlay
											key={
												item.kind === "blur"
													? `${item.region.id}-${overlaySize.width}-${overlaySize.height}-${item.region.blurData?.type ?? "blur"}-${item.region.blurData?.shape ?? "rectangle"}-${item.region.blurData?.color ?? "white"}-${Math.round(item.region.blurData?.blockSize ?? 0)}-${Math.round(item.region.blurData?.intensity ?? 0)}-${(item.region.blurData?.freehandPoints ?? []).map((p) => `${Math.round(p.x)}_${Math.round(p.y)}`).join("-")}`
													: `${item.region.id}-${overlaySize.width}-${overlaySize.height}`
											}
											annotation={item.region}
											isSelected={
												item.kind === "blur"
													? item.region.id === selectedBlurId
													: item.region.id === selectedAnnotationId
											}
											containerWidth={overlaySize.width}
											containerHeight={overlaySize.height}
											onPositionChange={(id, position) =>
												item.kind === "blur"
													? onBlurPositionChange?.(id, position)
													: onAnnotationPositionChange?.(id, position)
											}
											onSizeChange={(id, size) =>
												item.kind === "blur"
													? onBlurSizeChange?.(id, size)
													: onAnnotationSizeChange?.(id, size)
											}
											onBlurDataChange={
												item.kind === "blur"
													? (id, blurData) => onBlurDataChange?.(id, blurData)
													: undefined
											}
											onBlurDataCommit={item.kind === "blur" ? onBlurDataCommit : undefined}
											onClick={item.kind === "blur" ? handleBlurClick : handleAnnotationClick}
											zIndex={item.region.zIndex}
											isSelectedBoost={
												item.kind === "blur"
													? item.region.id === selectedBlurId
													: item.region.id === selectedAnnotationId
											}
											previewSourceCanvas={previewSnapshotCanvas}
											previewFrameVersion={Math.round(currentTime * 1000)}
										/>
									));
								})()}
							</div>
						)}
					</div>
					{/* Clip the native cursor overlay to the exact video canvas boundary.
				    Placed OUTSIDE composite3DRef (preserve-3d) so clip-path works
				    correctly even during 3D zoom rotation regions.
				    clip-path is set dynamically to the camera-aware video bounds.
				    Phase 6.5: lives inside the primary Rnd so the cursor follows
				    the primary tile when the user drags / resizes it. */}
					<div
						ref={nativeCursorClipRef}
						className="absolute inset-0"
						style={{ zIndex: 18, pointerEvents: "none" }}
					>
						<img
							ref={nativeCursorImageRef}
							alt=""
							aria-hidden="true"
							className="absolute left-0 top-0 select-none"
							style={{
								display: "none",
								pointerEvents: "none",
								transformOrigin: "0 0",
							}}
						/>
					</div>
				</Rnd>
				<video
					ref={videoRef}
					src={videoPath}
					className="hidden"
					preload="auto"
					playsInline
					onLoadedMetadata={handleLoadedMetadata}
					onDurationChange={(e) => {
						enableAllPreviewAudioTracks(e.currentTarget);
						if (!syncResolvedDuration(e.currentTarget)) {
							forceResolveDuration(e.currentTarget);
						}
					}}
					onLoadedData={(e) => {
						enableAllPreviewAudioTracks(e.currentTarget);
						if (!syncResolvedDuration(e.currentTarget)) {
							forceResolveDuration(e.currentTarget);
						}
					}}
					onCanPlay={(e) => {
						enableAllPreviewAudioTracks(e.currentTarget);
						if (!syncResolvedDuration(e.currentTarget)) {
							forceResolveDuration(e.currentTarget);
						}
					}}
					onError={() => onError("Failed to load video")}
				/>
				{supplementalAudioPath && (
					<audio ref={supplementalAudioRef} src={supplementalAudioPath} preload="auto" />
				)}
				<MultiLayerOverlay
					paths={additionalLayerPaths}
					layerIds={additionalLayerIds}
					transforms={layerTransforms}
					onUpdate={onLayerTransformUpdate}
					onCommit={onLayerTransformCommit}
					isPlaying={isPlaying}
					currentTime={currentTime}
				/>
			</div>
		);
	},
);

/**
 * Phase 3/4 multi-layer overlay. Renders each additional v3 layer as a
 * draggable + resizable picture-in-picture tile floating above the
 * primary PixiJS canvas. Each tile is synced to the primary playhead.
 *
 * Phase 4.5: tile positions/sizes live in the editor's undoable history
 * via `LayerTransform` (normalized 0..1 of the stage). This component is
 * stateless w.r.t. placement — it only renders transforms and forwards
 * drag/resize gestures back to VideoEditor.
 */
function MultiLayerOverlay({
	paths,
	layerIds,
	transforms,
	onUpdate,
	onCommit,
	isPlaying,
	currentTime,
}: {
	paths: string[];
	layerIds: string[];
	transforms: import("./projectPersistence").LayerTransform[];
	onUpdate?: (
		layerId: string,
		partial: Partial<import("./projectPersistence").LayerTransform>,
	) => void;
	onCommit?: () => void;
	isPlaying: boolean;
	currentTime: number;
}) {
	const videoRefs = useRef<(HTMLVideoElement | null)[]>([]);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [containerSize, setContainerSize] = useState<{ width: number; height: number }>({
		width: 0,
		height: 0,
	});
	// Phase 7 follow-up: cache each layer's natural video aspect so we can
	// drive lockAspectRatio per-tile (instead of the 16:9 default that
	// stretches Win11 Notepad / Electron windows in the initial placement).
	const [naturalAspects, setNaturalAspects] = useState<Record<string, number>>({});
	// Track which layers already had their initial aspect sync applied so
	// re-mounts of MultiLayerOverlay don't keep clobbering user-resized
	// tiles. Since user resize keeps the same aspect (lockAspectRatio),
	// even if this runs again the result is mathematically the same shape.
	const initialAspectSyncedRef = useRef<Set<string>>(new Set());

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const update = () => {
			setContainerSize({ width: el.clientWidth, height: el.clientHeight });
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		for (const video of videoRefs.current) {
			if (!video) continue;
			if (Math.abs(video.currentTime - currentTime) > 0.25) {
				try {
					video.currentTime = currentTime;
				} catch {
					// Seek may fail before metadata loads — next tick will retry.
				}
			}
			if (isPlaying && video.paused) {
				video.play().catch(() => undefined);
			} else if (!isPlaying && !video.paused) {
				video.pause();
			}
		}
	}, [isPlaying, currentTime]);

	if (paths.length === 0) return null;

	const transformByLayerId = new Map(transforms.map((t) => [t.layerId, t]));
	const stageWidth = containerSize.width;
	const stageHeight = containerSize.height;
	const haveStage = stageWidth > 0 && stageHeight > 0;

	return (
		// Phase 8: dropped zIndex on the container so each tile's Rnd
		// participates in the outerWrapperRef stacking context directly.
		// This lets Layer 1's zIndex be compared against Layer 2/3 tiles
		// for the user-facing Layer order UI. The outer div still spans
		// the stage for size measurement and lets pointer events fall
		// through to layers underneath.
		<div ref={containerRef} className="absolute inset-0" style={{ pointerEvents: "none" }}>
			{paths.map((path, idx) => {
				const layerId = layerIds[idx];
				const transform = layerId ? transformByLayerId.get(layerId) : undefined;
				// Until the container has been measured at least once we cannot
				// translate normalized transforms into pixels — skip rendering
				// rather than flash a wrong-size tile.
				if (!haveStage) return null;

				const fallbackWidthPx = 160;
				const fallbackHeightPx = 90;
				const widthPx = transform
					? Math.max(60, transform.size.width * stageWidth)
					: fallbackWidthPx;
				const heightPx = transform
					? Math.max(40, transform.size.height * stageHeight)
					: fallbackHeightPx;
				const xPx = transform ? transform.position.cx * stageWidth - widthPx / 2 : 16;
				const yPx = transform ? transform.position.cy * stageHeight - heightPx / 2 : 16 + idx * 100;

				const canEdit = Boolean(transform && layerId && onUpdate);
				const lockedAspect = layerId && naturalAspects[layerId] ? naturalAspects[layerId] : 16 / 9;

				return (
					<Rnd
						key={`${path}-${idx}`}
						size={{ width: widthPx, height: heightPx }}
						position={{ x: xPx, y: yPx }}
						bounds="parent"
						lockAspectRatio={lockedAspect}
						minWidth={120}
						minHeight={68}
						disableDragging={!canEdit}
						enableResizing={canEdit}
						onDrag={(_e, d) => {
							if (!layerId || !onUpdate) return;
							const cx = (d.x + widthPx / 2) / stageWidth;
							const cy = (d.y + heightPx / 2) / stageHeight;
							onUpdate(layerId, {
								position: {
									cx: Math.max(0, Math.min(1, cx)),
									cy: Math.max(0, Math.min(1, cy)),
								},
							});
						}}
						onDragStop={() => {
							onCommit?.();
						}}
						onResize={(_e, _dir, ref, _delta, position) => {
							if (!layerId || !onUpdate) return;
							const w = ref.offsetWidth;
							const h = ref.offsetHeight;
							const cx = (position.x + w / 2) / stageWidth;
							const cy = (position.y + h / 2) / stageHeight;
							onUpdate(layerId, {
								position: {
									cx: Math.max(0, Math.min(1, cx)),
									cy: Math.max(0, Math.min(1, cy)),
								},
								size: {
									width: Math.max(0.05, Math.min(1, w / stageWidth)),
									height: Math.max(0.05, Math.min(1, h / stageHeight)),
								},
							});
						}}
						onResizeStop={() => {
							onCommit?.();
						}}
						style={{
							border: "1px solid rgba(255,255,255,0.3)",
							borderRadius: 6,
							overflow: "hidden",
							background: "rgba(0,0,0,0.6)",
							boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
							pointerEvents: "auto",
							// Phase 8 z-order: pull from transform so the
							// Layer order UI in SettingsPanel controls which
							// tile sits on top of which.
							zIndex: 10 + (transform?.zOrder ?? idx),
						}}
					>
						<video
							ref={(el) => {
								videoRefs.current[idx] = el;
							}}
							src={path}
							muted
							playsInline
							preload="auto"
							className="h-full w-full object-cover pointer-events-none select-none"
							draggable={false}
							onLoadedMetadata={(e) => {
								const v = e.currentTarget;
								if (v.videoWidth <= 0 || v.videoHeight <= 0) return;
								if (!layerId) return;
								const aspect = v.videoWidth / v.videoHeight;
								setNaturalAspects((prev) =>
									prev[layerId] === aspect ? prev : { ...prev, [layerId]: aspect },
								);
								// Initial aspect sync: scale the persisted
								// transform's height to match the natural
								// aspect, keeping width constant. Runs once
								// per layer per mount. User-resized tiles
								// already follow lockAspectRatio so reapplying
								// the same math gives the same shape — safe.
								if (initialAspectSyncedRef.current.has(layerId)) return;
								if (!transform || !onUpdate) return;
								if (stageWidth <= 0 || stageHeight <= 0) return;
								const stageAspect = stageWidth / stageHeight;
								const newHeight = (transform.size.width * stageAspect) / aspect;
								const clampedHeight = Math.max(0.05, Math.min(1, newHeight));
								initialAspectSyncedRef.current.add(layerId);
								onUpdate(layerId, {
									size: { width: transform.size.width, height: clampedHeight },
								});
								onCommit?.();
							}}
						/>
						<div className="pointer-events-none absolute left-1 top-1 rounded bg-black/60 px-1 text-[9px] font-semibold text-white">
							{`Layer ${idx + 2}`}
						</div>
					</Rnd>
				);
			})}
		</div>
	);
}

VideoPlayback.displayName = "VideoPlayback";

export default VideoPlayback;
