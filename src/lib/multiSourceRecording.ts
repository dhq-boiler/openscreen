/**
 * Orchestrator for spawning N native recordings in parallel from a single
 * "press record" action. Wraps the per-platform start/pause/resume/stop
 * IPC calls so the UI layer can treat a multi-window session as one
 * logical recording.
 *
 * Phase 2 contract:
 * - One sessionId is generated up front and stamped into all layers.
 * - Each target gets a unique recordingId so the native handlers can
 *   route pause/resume/stop without ambiguity.
 * - Start fans out concurrently; any failure aborts the others.
 * - Stop collects each helper's screenVideoPath and assembles a single
 *   ProjectMediaV3 manifest the editor can consume.
 *
 * What this module deliberately does NOT do (out of scope for Phase 2):
 * - React state / refs (that's Phase 2-D in useScreenRecorder.ts).
 * - Cursor recording fan-out (Phase 6 — current cursor sampler is a
 *   process-global singleton on each platform and only one of the N
 *   sessions enables editable-overlay cursor capture).
 * - Audio mixing across sessions (Phase 6).
 */

import type { NativeMacRecordingRequest } from "./nativeMacRecording";
import type {
	NativeWindowsRecordingRequest,
	NativeWindowsRecordingStartResult,
} from "./nativeWindowsRecording";
import type { ProjectMediaV3, VideoLayer, WebcamLayer } from "./recordingSession";

export type RecordingPlatform = "win32" | "darwin";

export interface MultiSourceTargetCommon {
	/** Stable id used by editor layer transforms and zoom regions. */
	layerId: string;
	/** Numeric id passed to the native helper. Must be unique within a session. */
	recordingId: number;
	/** Optional UI label captured at record time (e.g. window title). */
	sourceLabel?: string;
}

export interface MultiSourceTargetWindows extends MultiSourceTargetCommon {
	platform: "win32";
	request: NativeWindowsRecordingRequest;
}

export interface MultiSourceTargetMac extends MultiSourceTargetCommon {
	platform: "darwin";
	request: NativeMacRecordingRequest;
}

export type MultiSourceTarget = MultiSourceTargetWindows | MultiSourceTargetMac;

export interface MultiSourceRecordingHandle {
	sessionId: string;
	layerIds: string[];
	/** Pause every active layer. Errors per layer are aggregated and rethrown. */
	pauseAll(): Promise<void>;
	resumeAll(): Promise<void>;
	stopAll(options?: { discard?: boolean }): Promise<ProjectMediaV3>;
}

interface ActiveLayerState {
	target: MultiSourceTarget;
	screenVideoPath: string;
	webcamVideoPath?: string;
}

/**
 * Generate a fresh sessionId. Format: `session-<base36 ms>-<rnd>`.
 */
export function newSessionId(): string {
	const ts = Date.now().toString(36);
	const rnd = Math.random().toString(36).slice(2, 6);
	return `session-${ts}-${rnd}`;
}

/**
 * Generate a fresh layerId. Independent from recordingId so it can stay
 * stable across project saves even if a recording is re-encoded.
 */
export function newLayerId(): string {
	return `layer-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Generate a fresh numeric recordingId. Uses Date.now() with a small
 * deterministic offset to avoid collisions when N sources are kicked off
 * in the same millisecond.
 */
export function newRecordingId(offset = 0): number {
	return Date.now() + offset;
}

function getElectronAPI() {
	if (typeof window === "undefined" || !window.electronAPI) {
		throw new Error("Multi-source recording requires the Electron preload bridge.");
	}
	return window.electronAPI;
}

async function startOneTarget(target: MultiSourceTarget): Promise<string> {
	const api = getElectronAPI();
	// Force-override the request's recordingId so we own id allocation.
	const request = {
		...target.request,
		recordingId: target.recordingId,
	} as MultiSourceTargetWindows["request"] | MultiSourceTargetMac["request"];

	const result: NativeWindowsRecordingStartResult =
		target.platform === "win32"
			? await api.startNativeWindowsRecording(request as NativeWindowsRecordingRequest)
			: await api.startNativeMacRecording(request as NativeMacRecordingRequest);

	if (!result.success) {
		throw new Error(
			result.error ?? `Failed to start ${target.platform} recording for layer ${target.layerId}.`,
		);
	}
	const path = result.path;
	if (!path) {
		throw new Error(
			`${target.platform} recording for layer ${target.layerId} returned no output path.`,
		);
	}
	return path;
}

async function stopOneTarget(
	target: MultiSourceTarget,
	options: { discard?: boolean } | undefined,
): Promise<{ screenVideoPath: string | null; webcamVideoPath?: string }> {
	const api = getElectronAPI();
	const payload = { discard: Boolean(options?.discard), recordingId: target.recordingId };
	const result =
		target.platform === "win32"
			? await api.stopNativeWindowsRecording(payload)
			: await api.stopNativeMacRecording(payload);

	if (!result.success) {
		throw new Error(
			result.error ?? `Failed to stop ${target.platform} recording for layer ${target.layerId}.`,
		);
	}
	if (options?.discard || result.discarded) {
		return { screenVideoPath: null };
	}

	return {
		screenVideoPath: result.path ?? result.session?.screenVideoPath ?? null,
		webcamVideoPath: result.session?.webcamVideoPath,
	};
}

async function pauseOneTarget(target: MultiSourceTarget): Promise<void> {
	const api = getElectronAPI();
	const result =
		target.platform === "win32"
			? await api.pauseNativeWindowsRecording(target.recordingId)
			: await api.pauseNativeMacRecording(target.recordingId);
	if (!result.success) {
		throw new Error(result.error ?? `Pause failed for layer ${target.layerId}.`);
	}
}

async function resumeOneTarget(target: MultiSourceTarget): Promise<void> {
	const api = getElectronAPI();
	const result =
		target.platform === "win32"
			? await api.resumeNativeWindowsRecording(target.recordingId)
			: await api.resumeNativeMacRecording(target.recordingId);
	if (!result.success) {
		throw new Error(result.error ?? `Resume failed for layer ${target.layerId}.`);
	}
}

/**
 * Aggregate per-layer rejections into a single Error whose message lists
 * each underlying failure. Successful results in the same batch are not
 * silently dropped: this helper is only called when at least one entry
 * failed, after the orchestrator has acted on the successes.
 */
function aggregateLayerErrors(
	results: PromiseSettledResult<unknown>[],
	verb: string,
): Error | null {
	const failures = results
		.map((r, i) =>
			r.status === "rejected"
				? `[layer ${i}] ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`
				: null,
		)
		.filter((s): s is string => s !== null);

	if (failures.length === 0) return null;
	return new Error(
		`Multi-source ${verb} failed on ${failures.length} layer(s):\n${failures.join("\n")}`,
	);
}

/**
 * Start N native recordings in parallel. On any failure, the orchestrator
 * attempts to stop already-started helpers with `discard: true` so we
 * don't leak running processes, then rethrows the aggregate error.
 */
export async function startMultiSourceRecording(
	targets: MultiSourceTarget[],
	options?: { sessionId?: string },
): Promise<MultiSourceRecordingHandle> {
	if (targets.length === 0) {
		throw new Error("startMultiSourceRecording requires at least one target.");
	}

	const sessionId = options?.sessionId ?? newSessionId();
	const layerIds = targets.map((t) => t.layerId);

	const startResults = await Promise.allSettled(targets.map((target) => startOneTarget(target)));

	const success: ActiveLayerState[] = [];
	const failureIndices: number[] = [];
	for (let i = 0; i < startResults.length; i++) {
		const result = startResults[i];
		if (result.status === "fulfilled") {
			success.push({ target: targets[i], screenVideoPath: result.value });
		} else {
			failureIndices.push(i);
		}
	}

	if (failureIndices.length > 0) {
		// Roll back any that did start so we don't leak helpers.
		await Promise.allSettled(success.map((s) => stopOneTarget(s.target, { discard: true })));
		throw aggregateLayerErrors(startResults, "start") ?? new Error("Multi-source start failed.");
	}

	return makeHandle(sessionId, layerIds, success);
}

function makeHandle(
	sessionId: string,
	layerIds: string[],
	active: ActiveLayerState[],
): MultiSourceRecordingHandle {
	let alive = true;

	return {
		sessionId,
		layerIds,
		async pauseAll() {
			if (!alive) throw new Error("Multi-source recording is no longer active.");
			const results = await Promise.allSettled(active.map((s) => pauseOneTarget(s.target)));
			const err = aggregateLayerErrors(results, "pause");
			if (err) throw err;
		},
		async resumeAll() {
			if (!alive) throw new Error("Multi-source recording is no longer active.");
			const results = await Promise.allSettled(active.map((s) => resumeOneTarget(s.target)));
			const err = aggregateLayerErrors(results, "resume");
			if (err) throw err;
		},
		async stopAll(stopOptions) {
			if (!alive) throw new Error("Multi-source recording is no longer active.");
			alive = false;

			const stopResults = await Promise.allSettled(
				active.map((s) => stopOneTarget(s.target, stopOptions)),
			);

			const layers: VideoLayer[] = [];
			let webcam: WebcamLayer | undefined;
			const errors: string[] = [];

			for (let i = 0; i < stopResults.length; i++) {
				const r = stopResults[i];
				const target = active[i].target;
				if (r.status === "rejected") {
					errors.push(
						`[layer ${target.layerId}] ${
							r.reason instanceof Error ? r.reason.message : String(r.reason)
						}`,
					);
					continue;
				}
				const screenPath = r.value.screenVideoPath;
				if (!screenPath) continue; // discarded

				layers.push({
					id: target.layerId,
					kind: pickLayerKind(target),
					screenVideoPath: screenPath,
					recordedAtMs: target.recordingId,
					...(target.sourceLabel ? { sourceLabel: target.sourceLabel } : {}),
				});

				if (!webcam && r.value.webcamVideoPath) {
					webcam = { webcamVideoPath: r.value.webcamVideoPath };
				}
			}

			if (errors.length > 0) {
				throw new Error(`Multi-source stop failed for some layers:\n${errors.join("\n")}`);
			}

			const media: ProjectMediaV3 = {
				schemaVersion: 3,
				sessionId,
				layers,
				...(webcam ? { webcam } : {}),
			};
			return media;
		},
	};
}

function pickLayerKind(target: MultiSourceTarget): VideoLayer["kind"] {
	if (target.platform === "win32") {
		return target.request.source.type === "window" ? "window" : "screen";
	}
	// macOS request typing: similar shape.
	const macSource = (target.request as NativeMacRecordingRequest).source;
	return macSource.type === "window" ? "window" : "screen";
}
