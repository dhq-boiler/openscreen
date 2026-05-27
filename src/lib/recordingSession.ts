export type CursorCaptureMode = "editable-overlay" | "system";

/**
 * v2 single-source media. Kept exported because many existing call sites
 * still consume this shape. New recordings produce {@link ProjectMediaV3};
 * loading code normalizes v2 → v3 transparently via {@link toProjectMediaV3}.
 */
export interface ProjectMedia {
	screenVideoPath: string;
	webcamVideoPath?: string;
	cursorCaptureMode?: CursorCaptureMode;
}

/**
 * One recorded screen/window in a session. A v3 ProjectMedia has 1..N of
 * these. The id is stable across project saves and is used by zoom regions,
 * annotations, layer transforms, etc. to reference a specific layer.
 */
export interface VideoLayer {
	id: string;
	kind: "screen" | "window";
	screenVideoPath: string;
	sourceWidth?: number;
	sourceHeight?: number;
	/** Wall-clock time (ms since epoch) when the helper started capturing this layer. */
	recordedAtMs?: number;
	/** Optional human-readable label captured at record time, e.g. window title. */
	sourceLabel?: string;
}

export interface WebcamLayer {
	webcamVideoPath: string;
	sourceWidth?: number;
	sourceHeight?: number;
}

export interface ProjectMediaV3 {
	schemaVersion: 3;
	/** Stable id shared by all layers from the same "press record" action. */
	sessionId: string;
	layers: VideoLayer[];
	webcam?: WebcamLayer;
	cursorCaptureMode?: CursorCaptureMode;
}

export interface RecordingSession extends ProjectMedia {
	createdAt: number;
}

export interface RecordingSessionV3 extends ProjectMediaV3 {
	createdAt: number;
}

export interface RecordedVideoAssetInput {
	fileName: string;
	videoData: ArrayBuffer;
}

export interface StoreRecordedSessionInput {
	screen: RecordedVideoAssetInput;
	webcam?: RecordedVideoAssetInput;
	createdAt?: number;
	cursorCaptureMode?: CursorCaptureMode;
}

export function normalizeCursorCaptureMode(value: unknown): CursorCaptureMode | undefined {
	return value === "editable-overlay" || value === "system" ? value : undefined;
}

function normalizePath(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function normalizeFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function normalizeProjectMedia(candidate: unknown): ProjectMedia | null {
	if (!candidate || typeof candidate !== "object") {
		return null;
	}

	const raw = candidate as Partial<ProjectMedia>;
	const screenVideoPath = normalizePath(raw.screenVideoPath);

	if (!screenVideoPath) {
		return null;
	}

	const webcamVideoPath = normalizePath(raw.webcamVideoPath);
	const cursorCaptureMode = normalizeCursorCaptureMode(raw.cursorCaptureMode);

	return {
		screenVideoPath,
		...(webcamVideoPath ? { webcamVideoPath } : {}),
		...(cursorCaptureMode ? { cursorCaptureMode } : {}),
	};
}

export function normalizeRecordingSession(candidate: unknown): RecordingSession | null {
	if (!candidate || typeof candidate !== "object") {
		return null;
	}

	const raw = candidate as Partial<RecordingSession>;
	const media = normalizeProjectMedia(raw);
	if (!media) {
		return null;
	}

	return {
		...media,
		createdAt:
			typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
				? raw.createdAt
				: Date.now(),
	};
}

function normalizeVideoLayer(candidate: unknown): VideoLayer | null {
	if (!candidate || typeof candidate !== "object") return null;
	const raw = candidate as Partial<VideoLayer>;

	const screenVideoPath = normalizePath(raw.screenVideoPath);
	if (!screenVideoPath) return null;

	const id =
		typeof raw.id === "string" && raw.id.trim().length > 0
			? raw.id.trim()
			: `layer-${Math.random().toString(36).slice(2, 10)}`;
	const kind = raw.kind === "window" ? "window" : "screen";

	const sourceWidth = normalizeFiniteNumber(raw.sourceWidth);
	const sourceHeight = normalizeFiniteNumber(raw.sourceHeight);
	const recordedAtMs = normalizeFiniteNumber(raw.recordedAtMs);
	const sourceLabel = typeof raw.sourceLabel === "string" ? raw.sourceLabel : undefined;

	return {
		id,
		kind,
		screenVideoPath,
		...(sourceWidth !== undefined ? { sourceWidth } : {}),
		...(sourceHeight !== undefined ? { sourceHeight } : {}),
		...(recordedAtMs !== undefined ? { recordedAtMs } : {}),
		...(sourceLabel ? { sourceLabel } : {}),
	};
}

function normalizeWebcamLayer(candidate: unknown): WebcamLayer | null {
	if (!candidate || typeof candidate !== "object") return null;
	const raw = candidate as Partial<WebcamLayer>;

	const webcamVideoPath = normalizePath(raw.webcamVideoPath);
	if (!webcamVideoPath) return null;

	const sourceWidth = normalizeFiniteNumber(raw.sourceWidth);
	const sourceHeight = normalizeFiniteNumber(raw.sourceHeight);

	return {
		webcamVideoPath,
		...(sourceWidth !== undefined ? { sourceWidth } : {}),
		...(sourceHeight !== undefined ? { sourceHeight } : {}),
	};
}

/**
 * Accept either a v2 ProjectMedia or v3 ProjectMediaV3 (or any raw object
 * that looks like one), return a normalized v3 with at least 1 layer, or
 * null if the input has no usable screen video path.
 *
 * v2 inputs become a single-layer v3 with a freshly-generated layer id.
 */
export function toProjectMediaV3(candidate: unknown): ProjectMediaV3 | null {
	if (!candidate || typeof candidate !== "object") return null;
	const raw = candidate as Partial<ProjectMediaV3> & Partial<ProjectMedia>;

	if (raw.schemaVersion === 3 && Array.isArray(raw.layers)) {
		const layers = raw.layers
			.map((layer) => normalizeVideoLayer(layer))
			.filter((layer): layer is VideoLayer => layer !== null);

		if (layers.length === 0) return null;

		const sessionId =
			typeof raw.sessionId === "string" && raw.sessionId.trim().length > 0
				? raw.sessionId.trim()
				: `session-${Date.now().toString(36)}`;
		const webcam = raw.webcam ? normalizeWebcamLayer(raw.webcam) : null;
		const cursorCaptureMode = normalizeCursorCaptureMode(raw.cursorCaptureMode);

		return {
			schemaVersion: 3,
			sessionId,
			layers,
			...(webcam ? { webcam } : {}),
			...(cursorCaptureMode ? { cursorCaptureMode } : {}),
		};
	}

	// v2 fallback — single-source ProjectMedia.
	const v2 = normalizeProjectMedia(raw);
	if (!v2) return null;

	const sessionId = `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
	const layer: VideoLayer = {
		id: `layer-${Math.random().toString(36).slice(2, 10)}`,
		kind: "screen",
		screenVideoPath: v2.screenVideoPath,
	};

	return {
		schemaVersion: 3,
		sessionId,
		layers: [layer],
		...(v2.webcamVideoPath
			? { webcam: { webcamVideoPath: v2.webcamVideoPath } as WebcamLayer }
			: {}),
		...(v2.cursorCaptureMode ? { cursorCaptureMode: v2.cursorCaptureMode } : {}),
	};
}

/**
 * Convenience: pull the first (or primary) layer from a v3 media. Useful
 * during Phase 2 when the editor still only knows how to render one layer.
 */
export function primaryScreenVideoPath(media: ProjectMediaV3 | ProjectMedia | null): string | null {
	if (!media) return null;
	if ("schemaVersion" in media && media.schemaVersion === 3) {
		return media.layers[0]?.screenVideoPath ?? null;
	}
	return (media as ProjectMedia).screenVideoPath ?? null;
}
