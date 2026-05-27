import { normalizeBlurColor, normalizeBlurType } from "@/lib/blurEffects";
import type { ExportFormat, ExportQuality, GifFrameRate, GifSizePreset } from "@/lib/exporter";
import type { ProjectMedia, ProjectMediaV3 } from "@/lib/recordingSession";
import { normalizeProjectMedia, toProjectMediaV3 } from "@/lib/recordingSession";
import { DEFAULT_WALLPAPER, WALLPAPER_PATHS } from "@/lib/wallpaper";
import { ASPECT_RATIOS, type AspectRatio, isPortraitAspectRatio } from "@/utils/aspectRatioUtils";
import {
	DEFAULT_EDITOR_APPEARANCE_SETTINGS,
	DEFAULT_EDITOR_LAYOUT_SETTINGS,
	DEFAULT_EXPORT_SETTINGS,
	DEFAULT_GIF_SETTINGS,
	DEFAULT_WEBCAM_SETTINGS,
} from "./editorDefaults";
import {
	type AnnotationRegion,
	type CropRegion,
	clampPlaybackSpeed,
	DEFAULT_ANNOTATION_POSITION,
	DEFAULT_ANNOTATION_SIZE,
	DEFAULT_ANNOTATION_STYLE,
	DEFAULT_BLUR_BLOCK_SIZE,
	DEFAULT_BLUR_DATA,
	DEFAULT_BLUR_FREEHAND_POINTS,
	DEFAULT_BLUR_INTENSITY,
	DEFAULT_FIGURE_DATA,
	DEFAULT_PLAYBACK_SPEED,
	DEFAULT_ZOOM_DEPTH,
	DEFAULT_ZOOM_MOTION_BLUR,
	MAX_BLUR_BLOCK_SIZE,
	MAX_BLUR_INTENSITY,
	MAX_PLAYBACK_SPEED,
	MIN_BLUR_BLOCK_SIZE,
	MIN_BLUR_INTENSITY,
	MIN_PLAYBACK_SPEED,
	type SpeedRegion,
	type TrimRegion,
	type WebcamLayoutPreset,
	type WebcamMaskShape,
	type WebcamPosition,
	type WebcamSizePreset,
	type ZoomRegion,
} from "./types";

const VALID_BLUR_SHAPES = new Set(["rectangle", "oval", "freehand"] as const);

// Pre-fix projects could persist resolved file:// URLs (machine-specific) for
// bundled wallpapers. Rewrite only paths that match a known install layout
// (resources/[assets/]wallpapers for packaged, public/wallpapers for dev) so
// a legitimate user file that happens to live in a folder named "wallpapers"
// elsewhere is never silently replaced.
const LEGACY_FILE_WALLPAPER_RE =
	/^file:\/\/.*?\/(?:resources\/(?:assets\/)?|public\/)wallpapers\/(wallpaper\d+\.jpg)$/i;
const CANONICAL_WALLPAPERS = new Set(WALLPAPER_PATHS);

function normalizeWallpaperValue(value: string): string {
	const match = LEGACY_FILE_WALLPAPER_RE.exec(value);
	if (!match) return value;
	const canonical = `/wallpapers/${match[1]}`;
	return CANONICAL_WALLPAPERS.has(canonical) ? canonical : DEFAULT_WALLPAPER;
}

export const PROJECT_VERSION = 3;

/**
 * Per-layer placement on the editor's virtual desktop. Introduced in v3.
 * Single-layer v2 projects migrate to a single LayerTransform that occupies
 * the full stage (cx=0.5, cy=0.5, width=1, height=1, zOrder=0).
 */
export interface LayerTransform {
	layerId: string;
	position: { cx: number; cy: number };
	size: { width: number; height: number };
	rotation: number;
	zOrder: number;
	visible: boolean;
	cornerRadius?: number;
}

export interface ProjectEditorState {
	wallpaper: string;
	shadowIntensity: number;
	showBlur: boolean;
	motionBlurAmount: number;
	borderRadius: number;
	padding: number;
	cropRegion: CropRegion;
	zoomRegions: ZoomRegion[];
	trimRegions: TrimRegion[];
	speedRegions: SpeedRegion[];
	annotationRegions: AnnotationRegion[];
	aspectRatio: AspectRatio;
	webcamLayoutPreset: WebcamLayoutPreset;
	webcamMaskShape: WebcamMaskShape;
	webcamSizePreset: WebcamSizePreset;
	webcamPosition: WebcamPosition | null;
	exportQuality: ExportQuality;
	exportFormat: ExportFormat;
	gifFrameRate: GifFrameRate;
	gifLoop: boolean;
	gifSizePreset: GifSizePreset;
	/**
	 * Per-layer transforms. Optional on disk for backward compatibility —
	 * when absent the loader synthesizes a single full-stage transform per
	 * layer. Phase 4 will populate this from user drag/resize input.
	 */
	layerTransforms?: LayerTransform[];
}

export interface EditorProjectData {
	version: number;
	/** v2 single-source media (kept for backward compat on save+load). */
	media?: ProjectMedia;
	/** v3 multi-layer media. When present, takes precedence over `media`. */
	mediaV3?: ProjectMediaV3;
	editor: ProjectEditorState;
	/** Pre-v2 legacy field. Still loaded; new projects do not write it. */
	videoPath?: string;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function computeNormalizedWebcamLayoutPreset(
	webcamLayoutPreset: Partial<ProjectEditorState>["webcamLayoutPreset"],
	normalizedAspectRatio: AspectRatio,
): WebcamLayoutPreset {
	switch (webcamLayoutPreset) {
		case "picture-in-picture":
		case "no-webcam":
			return webcamLayoutPreset;
		case "vertical-stack":
			return isPortraitAspectRatio(normalizedAspectRatio)
				? webcamLayoutPreset
				: DEFAULT_WEBCAM_SETTINGS.layoutPreset;
		case "dual-frame":
			return isPortraitAspectRatio(normalizedAspectRatio)
				? DEFAULT_WEBCAM_SETTINGS.layoutPreset
				: webcamLayoutPreset;
		default:
			return DEFAULT_WEBCAM_SETTINGS.layoutPreset;
	}
}

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

function encodePathSegments(pathname: string, keepWindowsDrive = false): string {
	return pathname
		.split("/")
		.map((segment, index) => {
			if (!segment) {
				return segment;
			}
			if (keepWindowsDrive && index === 0 && /^[a-zA-Z]:$/.test(segment)) {
				return segment;
			}
			return encodeURIComponent(segment);
		})
		.join("/");
}

export function toFileUrl(filePath: string): string {
	const normalized = filePath.replace(/\\/g, "/");
	if (normalized.match(/^[a-zA-Z]:/)) {
		return `file:///${encodePathSegments(normalized, true)}`;
	}
	if (normalized.startsWith("//")) {
		const withoutPrefix = normalized.slice(2);
		const [host = "", ...segments] = withoutPrefix.split("/");
		return `file://${host}/${encodePathSegments(segments.join("/"))}`;
	}
	const absolutePath = normalized.startsWith("/") ? normalized : `/${normalized}`;
	return `file://${encodePathSegments(absolutePath)}`;
}

export function fromFileUrl(fileUrl: string): string {
	if (!fileUrl.startsWith("file://")) {
		return fileUrl;
	}

	try {
		const url = new URL(fileUrl);
		const pathname = decodeURIComponent(url.pathname);

		if (url.host && url.host !== "localhost") {
			return `//${url.host}${pathname}`;
		}

		if (/^\/[a-zA-Z]:/.test(pathname)) {
			return pathname.slice(1);
		}

		return pathname;
	} catch {
		const fallbackPath = decodeURIComponent(fileUrl.replace(/^file:\/\//, ""));
		return fallbackPath.replace(/^\/([a-zA-Z]:)/, "$1");
	}
}

export function deriveNextId(prefix: string, ids: string[]): number {
	const max = ids.reduce((acc, id) => {
		const match = id.match(new RegExp(`^${prefix}-(\\d+)$`));
		if (!match) return acc;
		const value = Number(match[1]);
		return Number.isFinite(value) ? Math.max(acc, value) : acc;
	}, 0);
	return max + 1;
}

export function validateProjectData(candidate: unknown): candidate is EditorProjectData {
	if (!candidate || typeof candidate !== "object") return false;
	const project = candidate as Partial<EditorProjectData>;
	if (typeof project.version !== "number") return false;
	if (!resolveProjectMediaV3(project)) return false;
	if (!project.editor || typeof project.editor !== "object") return false;
	return true;
}

export function resolveProjectMedia(
	candidate: Partial<EditorProjectData> | { media?: unknown; videoPath?: unknown },
): ProjectMedia | null {
	const media = normalizeProjectMedia(candidate.media);
	if (media) {
		return media;
	}

	if (typeof candidate.videoPath === "string" && candidate.videoPath.trim()) {
		return { screenVideoPath: candidate.videoPath };
	}

	return null;
}

/**
 * Resolve a project's media into the unified v3 shape regardless of which
 * version it was saved as. Precedence: mediaV3 → media → videoPath.
 */
export function resolveProjectMediaV3(
	candidate:
		| Partial<EditorProjectData>
		| { mediaV3?: unknown; media?: unknown; videoPath?: unknown },
): ProjectMediaV3 | null {
	const v3 = toProjectMediaV3((candidate as { mediaV3?: unknown }).mediaV3);
	if (v3) return v3;

	const v2 = resolveProjectMedia(candidate as Partial<EditorProjectData>);
	if (v2) return toProjectMediaV3(v2);

	return null;
}

export function normalizeProjectEditor(editor: Partial<ProjectEditorState>): ProjectEditorState {
	const validAspectRatios = new Set<AspectRatio>(ASPECT_RATIOS);
	const normalizedAspectRatio: AspectRatio = validAspectRatios.has(
		editor.aspectRatio as AspectRatio,
	)
		? (editor.aspectRatio as AspectRatio)
		: DEFAULT_EDITOR_LAYOUT_SETTINGS.aspectRatio;
	const normalizedWebcamLayoutPreset = computeNormalizedWebcamLayoutPreset(
		editor.webcamLayoutPreset,
		normalizedAspectRatio,
	);
	const normalizedWebcamPosition: WebcamPosition | null =
		normalizedWebcamLayoutPreset === "picture-in-picture" &&
		editor.webcamPosition &&
		typeof editor.webcamPosition === "object" &&
		isFiniteNumber((editor.webcamPosition as WebcamPosition).cx) &&
		isFiniteNumber((editor.webcamPosition as WebcamPosition).cy)
			? {
					cx: clamp((editor.webcamPosition as WebcamPosition).cx, 0, 1),
					cy: clamp((editor.webcamPosition as WebcamPosition).cy, 0, 1),
				}
			: DEFAULT_WEBCAM_SETTINGS.position;

	const normalizedZoomRegions: ZoomRegion[] = Array.isArray(editor.zoomRegions)
		? editor.zoomRegions
				.filter((region): region is ZoomRegion => Boolean(region && typeof region.id === "string"))
				.map((region) => {
					const rawStart = isFiniteNumber(region.startMs) ? Math.round(region.startMs) : 0;
					const rawEnd = isFiniteNumber(region.endMs) ? Math.round(region.endMs) : rawStart + 1000;
					const startMs = Math.max(0, Math.min(rawStart, rawEnd));
					const endMs = Math.max(startMs + 1, rawEnd);

					const validPreset =
						region.rotationPreset === "iso" ||
						region.rotationPreset === "left" ||
						region.rotationPreset === "right"
							? region.rotationPreset
							: undefined;
					return {
						id: region.id,
						startMs,
						endMs,
						depth: [1, 2, 3, 4, 5, 6].includes(region.depth) ? region.depth : DEFAULT_ZOOM_DEPTH,
						focus: {
							cx: clamp(isFiniteNumber(region.focus?.cx) ? region.focus.cx : 0.5, 0, 1),
							cy: clamp(isFiniteNumber(region.focus?.cy) ? region.focus.cy : 0.5, 0, 1),
						},
						focusMode: region.focusMode === "auto" ? "auto" : "manual",
						...(validPreset ? { rotationPreset: validPreset } : {}),
						...(typeof region.layerId === "string" && region.layerId.trim().length > 0
							? { layerId: region.layerId.trim() }
							: {}),
					};
				})
		: [];

	const normalizedTrimRegions: TrimRegion[] = Array.isArray(editor.trimRegions)
		? editor.trimRegions
				.filter((region): region is TrimRegion => Boolean(region && typeof region.id === "string"))
				.map((region) => {
					const rawStart = isFiniteNumber(region.startMs) ? Math.round(region.startMs) : 0;
					const rawEnd = isFiniteNumber(region.endMs) ? Math.round(region.endMs) : rawStart + 1000;
					const startMs = Math.max(0, Math.min(rawStart, rawEnd));
					const endMs = Math.max(startMs + 1, rawEnd);
					return {
						id: region.id,
						startMs,
						endMs,
					};
				})
		: [];

	const normalizedSpeedRegions: SpeedRegion[] = Array.isArray(editor.speedRegions)
		? editor.speedRegions
				.filter((region): region is SpeedRegion => Boolean(region && typeof region.id === "string"))
				.map((region) => {
					const rawStart = isFiniteNumber(region.startMs) ? Math.round(region.startMs) : 0;
					const rawEnd = isFiniteNumber(region.endMs) ? Math.round(region.endMs) : rawStart + 1000;
					const startMs = Math.max(0, Math.min(rawStart, rawEnd));
					const endMs = Math.max(startMs + 1, rawEnd);

					const speed =
						isFiniteNumber(region.speed) &&
						region.speed >= MIN_PLAYBACK_SPEED &&
						region.speed <= MAX_PLAYBACK_SPEED
							? clampPlaybackSpeed(region.speed)
							: DEFAULT_PLAYBACK_SPEED;

					return {
						id: region.id,
						startMs,
						endMs,
						speed,
					};
				})
		: [];

	const normalizedAnnotationRegions: AnnotationRegion[] = Array.isArray(editor.annotationRegions)
		? editor.annotationRegions
				.filter((region): region is AnnotationRegion =>
					Boolean(region && typeof region.id === "string"),
				)
				.map((region, index) => {
					const rawStart = isFiniteNumber(region.startMs) ? Math.round(region.startMs) : 0;
					const rawEnd = isFiniteNumber(region.endMs) ? Math.round(region.endMs) : rawStart + 1000;
					const startMs = Math.max(0, Math.min(rawStart, rawEnd));
					const endMs = Math.max(startMs + 1, rawEnd);
					const blurShape =
						typeof region.blurData?.shape === "string" &&
						VALID_BLUR_SHAPES.has(region.blurData.shape)
							? region.blurData.shape
							: DEFAULT_BLUR_DATA.shape;
					const blurType = normalizeBlurType(region.blurData?.type);
					const blurColor = normalizeBlurColor(region.blurData?.color);

					return {
						id: region.id,
						startMs,
						endMs,
						type:
							region.type === "image" || region.type === "figure" || region.type === "blur"
								? region.type
								: "text",
						content: typeof region.content === "string" ? region.content : "",
						textContent: typeof region.textContent === "string" ? region.textContent : undefined,
						imageContent: typeof region.imageContent === "string" ? region.imageContent : undefined,
						position: {
							x: clamp(
								isFiniteNumber(region.position?.x)
									? region.position.x
									: DEFAULT_ANNOTATION_POSITION.x,
								0,
								100,
							),
							y: clamp(
								isFiniteNumber(region.position?.y)
									? region.position.y
									: DEFAULT_ANNOTATION_POSITION.y,
								0,
								100,
							),
						},
						size: {
							width: clamp(
								isFiniteNumber(region.size?.width)
									? region.size.width
									: DEFAULT_ANNOTATION_SIZE.width,
								1,
								200,
							),
							height: clamp(
								isFiniteNumber(region.size?.height)
									? region.size.height
									: DEFAULT_ANNOTATION_SIZE.height,
								1,
								200,
							),
						},
						style: {
							...DEFAULT_ANNOTATION_STYLE,
							...(region.style && typeof region.style === "object" ? region.style : {}),
						},
						zIndex: isFiniteNumber(region.zIndex) ? region.zIndex : index + 1,
						figureData: region.figureData
							? {
									...DEFAULT_FIGURE_DATA,
									...region.figureData,
								}
							: undefined,
						blurData:
							region.blurData && typeof region.blurData === "object"
								? {
										...DEFAULT_BLUR_DATA,
										...region.blurData,
										type: blurType,
										shape: blurShape,
										color: blurColor,
										intensity: isFiniteNumber(region.blurData.intensity)
											? clamp(region.blurData.intensity, MIN_BLUR_INTENSITY, MAX_BLUR_INTENSITY)
											: DEFAULT_BLUR_INTENSITY,
										blockSize: isFiniteNumber(region.blurData.blockSize)
											? clamp(region.blurData.blockSize, MIN_BLUR_BLOCK_SIZE, MAX_BLUR_BLOCK_SIZE)
											: DEFAULT_BLUR_BLOCK_SIZE,
										freehandPoints: Array.isArray(region.blurData.freehandPoints)
											? region.blurData.freehandPoints
													.filter(
														(
															point,
														): point is {
															x: number;
															y: number;
														} =>
															Boolean(
																point &&
																	isFiniteNumber((point as { x?: unknown }).x) &&
																	isFiniteNumber((point as { y?: unknown }).y),
															),
													)
													.map((point) => ({
														x: clamp(point.x, 0, 100),
														y: clamp(point.y, 0, 100),
													}))
											: DEFAULT_BLUR_FREEHAND_POINTS,
									}
								: undefined,
					};
				})
		: [];

	const rawCropX = isFiniteNumber(editor.cropRegion?.x)
		? editor.cropRegion.x
		: DEFAULT_EDITOR_LAYOUT_SETTINGS.cropRegion.x;
	const rawCropY = isFiniteNumber(editor.cropRegion?.y)
		? editor.cropRegion.y
		: DEFAULT_EDITOR_LAYOUT_SETTINGS.cropRegion.y;
	const rawCropWidth = isFiniteNumber(editor.cropRegion?.width)
		? editor.cropRegion.width
		: DEFAULT_EDITOR_LAYOUT_SETTINGS.cropRegion.width;
	const rawCropHeight = isFiniteNumber(editor.cropRegion?.height)
		? editor.cropRegion.height
		: DEFAULT_EDITOR_LAYOUT_SETTINGS.cropRegion.height;

	const cropX = clamp(rawCropX, 0, 1);
	const cropY = clamp(rawCropY, 0, 1);
	const cropWidth = clamp(rawCropWidth, 0.01, 1 - cropX);
	const cropHeight = clamp(rawCropHeight, 0.01, 1 - cropY);

	return {
		wallpaper:
			typeof editor.wallpaper === "string"
				? normalizeWallpaperValue(editor.wallpaper)
				: DEFAULT_EDITOR_LAYOUT_SETTINGS.wallpaper,
		shadowIntensity:
			typeof editor.shadowIntensity === "number"
				? editor.shadowIntensity
				: DEFAULT_EDITOR_APPEARANCE_SETTINGS.shadowIntensity,
		showBlur:
			typeof editor.showBlur === "boolean"
				? editor.showBlur
				: DEFAULT_EDITOR_APPEARANCE_SETTINGS.showBlur,
		motionBlurAmount: isFiniteNumber(editor.motionBlurAmount)
			? clamp(editor.motionBlurAmount, 0, 1)
			: typeof (editor as { motionBlurEnabled?: unknown }).motionBlurEnabled === "boolean"
				? (editor as { motionBlurEnabled?: boolean }).motionBlurEnabled
					? DEFAULT_ZOOM_MOTION_BLUR
					: DEFAULT_EDITOR_APPEARANCE_SETTINGS.motionBlurAmount
				: DEFAULT_EDITOR_APPEARANCE_SETTINGS.motionBlurAmount,
		borderRadius:
			typeof editor.borderRadius === "number"
				? editor.borderRadius
				: DEFAULT_EDITOR_APPEARANCE_SETTINGS.borderRadius,
		padding: isFiniteNumber(editor.padding)
			? clamp(editor.padding, 0, 100)
			: DEFAULT_EDITOR_LAYOUT_SETTINGS.padding,
		cropRegion: {
			x: cropX,
			y: cropY,
			width: cropWidth,
			height: cropHeight,
		},
		zoomRegions: normalizedZoomRegions,
		trimRegions: normalizedTrimRegions,
		speedRegions: normalizedSpeedRegions,
		annotationRegions: normalizedAnnotationRegions,
		aspectRatio: normalizedAspectRatio,
		webcamLayoutPreset: normalizedWebcamLayoutPreset,
		webcamMaskShape:
			editor.webcamMaskShape === "rectangle" ||
			editor.webcamMaskShape === "circle" ||
			editor.webcamMaskShape === "square" ||
			editor.webcamMaskShape === "rounded"
				? editor.webcamMaskShape
				: DEFAULT_WEBCAM_SETTINGS.maskShape,
		webcamSizePreset:
			typeof editor.webcamSizePreset === "number" && isFiniteNumber(editor.webcamSizePreset)
				? Math.max(10, Math.min(50, editor.webcamSizePreset))
				: DEFAULT_WEBCAM_SETTINGS.sizePreset,
		webcamPosition: normalizedWebcamPosition,
		exportQuality:
			editor.exportQuality === "medium" || editor.exportQuality === "source"
				? editor.exportQuality
				: DEFAULT_EXPORT_SETTINGS.quality,
		exportFormat: editor.exportFormat === "gif" ? "gif" : DEFAULT_EXPORT_SETTINGS.format,
		gifFrameRate:
			editor.gifFrameRate === 15 ||
			editor.gifFrameRate === 20 ||
			editor.gifFrameRate === 25 ||
			editor.gifFrameRate === 30
				? editor.gifFrameRate
				: DEFAULT_GIF_SETTINGS.frameRate,
		gifLoop: typeof editor.gifLoop === "boolean" ? editor.gifLoop : DEFAULT_GIF_SETTINGS.loop,
		gifSizePreset:
			editor.gifSizePreset === "medium" ||
			editor.gifSizePreset === "large" ||
			editor.gifSizePreset === "original"
				? editor.gifSizePreset
				: DEFAULT_GIF_SETTINGS.sizePreset,
		...(Array.isArray(editor.layerTransforms)
			? { layerTransforms: normalizeLayerTransforms(editor.layerTransforms) }
			: {}),
	};
}

function normalizeLayerTransforms(raw: unknown[]): LayerTransform[] {
	return raw
		.filter((entry): entry is Partial<LayerTransform> & { layerId: string } =>
			Boolean(
				entry &&
					typeof entry === "object" &&
					typeof (entry as { layerId?: unknown }).layerId === "string",
			),
		)
		.map((entry) => ({
			layerId: entry.layerId,
			position: {
				cx: clamp(isFiniteNumber(entry.position?.cx) ? entry.position.cx : 0.5, 0, 1),
				cy: clamp(isFiniteNumber(entry.position?.cy) ? entry.position.cy : 0.5, 0, 1),
			},
			size: {
				width: clamp(isFiniteNumber(entry.size?.width) ? entry.size.width : 1, 0.05, 1),
				height: clamp(isFiniteNumber(entry.size?.height) ? entry.size.height : 1, 0.05, 1),
			},
			rotation: isFiniteNumber(entry.rotation) ? entry.rotation : 0,
			zOrder: isFiniteNumber(entry.zOrder) ? entry.zOrder : 0,
			visible: typeof entry.visible === "boolean" ? entry.visible : true,
			...(isFiniteNumber(entry.cornerRadius)
				? { cornerRadius: Math.max(0, entry.cornerRadius) }
				: {}),
		}));
}

/**
 * Build default LayerTransforms for a v3 media that has none persisted yet.
 *
 * - Primary layer (index 0) is centered and sized to the padded video
 *   content area so the editor's drag/resize Rnd wraps the actual primary
 *   frame, not the full wallpaper. paddingPercent matches the editor's
 *   padding slider (0-100) and uses the same `1 - (p/100) * 0.4` mapping
 *   as layoutUtils#computeBaseLayout.
 * - Additional layers (index ≥ 1) get a small bottom-aligned tile so the
 *   default placement matches the picture-in-picture pattern users expect
 *   from the multi-window UI; the user can drag/resize from there.
 */
export function defaultLayerTransformsForMedia(
	media: ProjectMediaV3,
	paddingPercent: number = 0,
): LayerTransform[] {
	const clampedPadding = Math.max(0, Math.min(100, paddingPercent));
	const primaryScale = 1.0 - (clampedPadding / 100) * 0.4;
	const tileWidth = 0.18;
	const tileHeight = 0.18 * (9 / 16);
	const tileMargin = 0.02;
	// zOrder is descending so the primary starts on top of the additional
	// picture-in-picture tiles. Users can flip the order via the Layer
	// order UI in SettingsPanel; the field is just an integer hint that
	// gets translated into a CSS z-index at render time.
	const layerCount = media.layers.length;
	return media.layers.map((layer, index) => {
		if (index === 0) {
			return {
				layerId: layer.id,
				position: { cx: 0.5, cy: 0.5 },
				size: { width: primaryScale, height: primaryScale },
				rotation: 0,
				zOrder: layerCount,
				visible: true,
			};
		}
		// Stack additional tiles along the bottom edge, growing left-to-right.
		const additionalIndex = index - 1;
		const cx = tileMargin + tileWidth / 2 + additionalIndex * (tileWidth + tileMargin);
		const cy = 1 - tileMargin - tileHeight / 2;
		return {
			layerId: layer.id,
			position: { cx, cy },
			size: { width: tileWidth, height: tileHeight },
			rotation: 0,
			zOrder: layerCount - index,
			visible: true,
		};
	});
}

export function createProjectData(
	media: ProjectMedia | ProjectMediaV3,
	editor: ProjectEditorState,
): EditorProjectData {
	// Preserve the caller's media shape on disk so that snapshots are
	// deterministic: v2 input writes only `media`, v3 input writes
	// `mediaV3` plus a v2 `media` shadow pointing at the primary layer
	// (so old builds and external tools can still open single-layer
	// projects). Migration v2→v3 happens on LOAD via resolveProjectMediaV3.
	const isV3 = (media as ProjectMediaV3).schemaVersion === 3;
	if (!isV3) {
		return {
			version: PROJECT_VERSION,
			media: media as ProjectMedia,
			editor,
		};
	}

	const v3 = media as ProjectMediaV3;
	const primaryLayer = v3.layers[0];
	const v2Shadow: ProjectMedia | undefined = primaryLayer
		? {
				screenVideoPath: primaryLayer.screenVideoPath,
				...(v3.webcam ? { webcamVideoPath: v3.webcam.webcamVideoPath } : {}),
				...(v3.cursorCaptureMode ? { cursorCaptureMode: v3.cursorCaptureMode } : {}),
			}
		: undefined;

	return {
		version: PROJECT_VERSION,
		...(v2Shadow ? { media: v2Shadow } : {}),
		mediaV3: v3,
		editor,
	};
}

export function createProjectSnapshot(
	media: ProjectMedia | ProjectMediaV3,
	editor: Partial<ProjectEditorState>,
): string {
	return JSON.stringify(createProjectData(media, normalizeProjectEditor(editor)));
}

export function hasProjectUnsavedChanges(
	currentSnapshot: string | null,
	baselineSnapshot: string | null,
): boolean {
	return Boolean(
		currentSnapshot !== null && baselineSnapshot !== null && currentSnapshot !== baselineSnapshot,
	);
}
