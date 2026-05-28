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

import {
	type DisplayMediaWindowCaptureHandle,
	type PreparedDisplayMediaWindowCapture,
	prepareDisplayMediaWindowCapture,
} from "./displayMediaWindowCapture";
import type { NativeMacRecordingRequest } from "./nativeMacRecording";
import type {
	NativeWindowsRecordingRequest,
	NativeWindowsRecordingStartResult,
} from "./nativeWindowsRecording";
import type { ProjectMediaV3, VideoLayer, WebcamLayer } from "./recordingSession";

export type RecordingPlatform = "win32" | "darwin" | "display-media";

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

/**
 * Phase 7: getUserMedia + MediaRecorder based fallback for GPU-rendered
 * windows that WGC + PrintWindow + BitBlt can't reach (Win11 Notepad,
 * Electron apps, anything DirectComposition). Recorder runs in the
 * renderer; the resulting blob is persisted via the
 * save-display-media-recording IPC.
 */
export interface MultiSourceTargetDisplayMedia extends MultiSourceTargetCommon {
	platform: "display-media";
	sourceId: string;
	/** Base file name; main process joins with RECORDINGS_DIR. */
	fileName: string;
	fps: number;
	maxWidth?: number;
	maxHeight?: number;
}

export type MultiSourceTarget =
	| MultiSourceTargetWindows
	| MultiSourceTargetMac
	| MultiSourceTargetDisplayMedia;

export interface MultiSourceRecordingHandle {
	sessionId: string;
	layerIds: string[];
	/** Pause every active layer. Errors per layer are aggregated and rethrown. */
	pauseAll(): Promise<void>;
	resumeAll(): Promise<void>;
	stopAll(options?: { discard?: boolean }): Promise<ProjectMediaV3>;
}

/**
 * Returned by {@link prepareMultiSourceRecording}: every layer has done
 * its heavy init (getUserMedia / WGC helper warmup) but capture has not
 * begun. `commit()` flips all layers to recording (cheap), `discard()`
 * tears the prepared resources down (used on countdown cancel).
 */
export interface PreparedMultiSourceRecording {
	sessionId: string;
	layerIds: string[];
	commit(): Promise<MultiSourceRecordingHandle>;
	discard(): Promise<void>;
}

interface ActiveLayerState {
	target: MultiSourceTarget;
	screenVideoPath: string;
	webcamVideoPath?: string;
	/** Phase 7: in-process handle for display-media targets (null for native). */
	displayMediaHandle?: DisplayMediaWindowCaptureHandle;
}

/**
 * Per-target prepared state. For display-media we already hold the
 * getUserMedia stream + MediaRecorder; for win32 (Phase B) the native
 * helper is spawned in armed mode and we cache its recordingId + output
 * path so commit can address the same process. mac native prepare is
 * still a no-op pending a future port of the armed-start protocol to
 * the macOS helper.
 */
interface PreparedLayerState {
	target: MultiSourceTarget;
	displayMediaPrepared?: PreparedDisplayMediaWindowCapture;
	nativeWindowsArmedRecordingId?: number;
	nativeWindowsArmedPath?: string;
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

/**
 * First half of the two-stage start: do the heavy per-target init that
 * can run concurrently with the record countdown. For display-media this
 * is getUserMedia + MediaRecorder construction; for win32 it spawns the
 * native helper in armed mode (WGC + Media Foundation init) and caches
 * its recordingId for commit. mac native prepare is still a no-op until
 * the macOS helper supports armed start — it falls back to a one-shot
 * start at commit time.
 */
async function prepareOneTarget(target: MultiSourceTarget): Promise<PreparedLayerState> {
	if (target.platform === "display-media") {
		const prepared = await prepareDisplayMediaWindowCapture({
			sourceId: target.sourceId,
			fileName: target.fileName,
			fps: target.fps,
			maxWidth: target.maxWidth,
			maxHeight: target.maxHeight,
		});
		return { target, displayMediaPrepared: prepared };
	}

	if (target.platform === "win32") {
		const api = getElectronAPI();
		const request = {
			...target.request,
			recordingId: target.recordingId,
		} as NativeWindowsRecordingRequest;
		const result = await api.prepareNativeWindowsRecording(request);
		if (!result.success) {
			throw new Error(
				result.error ?? `Failed to prepare win32 recording for layer ${target.layerId}.`,
			);
		}
		const path = result.path;
		if (!path) {
			throw new Error(
				`win32 recording for layer ${target.layerId} returned no output path during prepare.`,
			);
		}
		return {
			target,
			nativeWindowsArmedRecordingId: target.recordingId,
			nativeWindowsArmedPath: path,
		};
	}

	// darwin: prepare is a no-op until the macOS helper learns armed mode.
	return { target };
}

function discardOneTarget(prepared: PreparedLayerState): void {
	prepared.displayMediaPrepared?.discard();
	if (prepared.nativeWindowsArmedRecordingId !== undefined) {
		// Send a stop with `discard: true` so the armed helper exits
		// cleanly without producing an output file. We don't await so
		// callers in `discard()` can stay synchronous; the helper exits
		// in <100ms in practice.
		try {
			void getElectronAPI()
				.stopNativeWindowsRecording({
					recordingId: prepared.nativeWindowsArmedRecordingId,
					discard: true,
				})
				.catch(() => {
					// Best-effort cleanup. If the IPC fails the helper
					// will still exit when its stdin closes.
				});
		} catch {
			// getElectronAPI threw — nothing left to clean up.
		}
	}
}

/**
 * Second half of the two-stage start: flip the prepared layer into a
 * recording state. For display-media this is just `recorder.start()`;
 * for an armed win32 helper it sends the stdin "start" command via the
 * commit IPC; mac (or an unprepared win32) falls back to a one-shot
 * start IPC.
 */
async function commitOneTarget(
	prepared: PreparedLayerState,
): Promise<{ screenVideoPath: string; displayMediaHandle?: DisplayMediaWindowCaptureHandle }> {
	const target = prepared.target;
	if (target.platform === "display-media") {
		if (!prepared.displayMediaPrepared) {
			throw new Error(`display-media layer ${target.layerId} was not prepared before commit.`);
		}
		const handle = prepared.displayMediaPrepared.commit();
		// Provisional path: stopOneTarget will refresh this with the
		// definitive on-disk path the main process resolved.
		return { screenVideoPath: target.fileName, displayMediaHandle: handle };
	}

	const api = getElectronAPI();

	// Phase B fast path: the win32 helper was already armed during
	// prepare; commit just flips it into the capture loop.
	if (target.platform === "win32" && prepared.nativeWindowsArmedRecordingId !== undefined) {
		const result = await api.commitNativeWindowsRecording(prepared.nativeWindowsArmedRecordingId);
		if (!result.success) {
			throw new Error(
				result.error ?? `Failed to commit win32 recording for layer ${target.layerId}.`,
			);
		}
		const path = prepared.nativeWindowsArmedPath ?? result.path;
		if (!path) {
			throw new Error(
				`win32 recording for layer ${target.layerId} returned no output path on commit.`,
			);
		}
		return { screenVideoPath: path };
	}

	// Fallback (mac, or win32 without prepare): original one-shot start.
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
	return { screenVideoPath: path };
}

async function stopOneTarget(
	state: ActiveLayerState,
	options: { discard?: boolean } | undefined,
): Promise<{ screenVideoPath: string | null; webcamVideoPath?: string }> {
	const target = state.target;
	if (target.platform === "display-media") {
		if (state.displayMediaHandle) {
			const result = await state.displayMediaHandle.stop();
			if (options?.discard) {
				return { screenVideoPath: null };
			}
			return { screenVideoPath: result.outputPath };
		}
		return { screenVideoPath: null };
	}

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

async function pauseOneTarget(state: ActiveLayerState): Promise<void> {
	const target = state.target;
	if (target.platform === "display-media") {
		state.displayMediaHandle?.pause();
		return;
	}
	const api = getElectronAPI();
	const result =
		target.platform === "win32"
			? await api.pauseNativeWindowsRecording(target.recordingId)
			: await api.pauseNativeMacRecording(target.recordingId);
	if (!result.success) {
		throw new Error(result.error ?? `Pause failed for layer ${target.layerId}.`);
	}
}

async function resumeOneTarget(state: ActiveLayerState): Promise<void> {
	const target = state.target;
	if (target.platform === "display-media") {
		state.displayMediaHandle?.resume();
		return;
	}
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
 * Prepare N layers in parallel. Each layer's prepare phase runs
 * concurrently so the slowest one bounds the wall-clock cost. Failures
 * roll back any successful prepares so we don't leak handles.
 */
export async function prepareMultiSourceRecording(
	targets: MultiSourceTarget[],
	options?: { sessionId?: string },
): Promise<PreparedMultiSourceRecording> {
	if (targets.length === 0) {
		throw new Error("prepareMultiSourceRecording requires at least one target.");
	}

	const sessionId = options?.sessionId ?? newSessionId();
	const layerIds = targets.map((t) => t.layerId);

	const prepareResults = await Promise.allSettled(
		targets.map((target) => prepareOneTarget(target)),
	);

	const prepared: PreparedLayerState[] = [];
	const failureIndices: number[] = [];
	for (let i = 0; i < prepareResults.length; i++) {
		const result = prepareResults[i];
		if (result.status === "fulfilled") {
			prepared.push(result.value);
		} else {
			failureIndices.push(i);
		}
	}

	if (failureIndices.length > 0) {
		for (const p of prepared) discardOneTarget(p);
		throw (
			aggregateLayerErrors(prepareResults, "prepare") ?? new Error("Multi-source prepare failed.")
		);
	}

	let consumed = false;

	return {
		sessionId,
		layerIds,
		async commit() {
			if (consumed) throw new Error("PreparedMultiSourceRecording already consumed.");
			consumed = true;

			const commitResults = await Promise.allSettled(prepared.map((p) => commitOneTarget(p)));

			const success: ActiveLayerState[] = [];
			const commitFailureIndices: number[] = [];
			for (let i = 0; i < commitResults.length; i++) {
				const result = commitResults[i];
				if (result.status === "fulfilled") {
					success.push({
						target: prepared[i].target,
						screenVideoPath: result.value.screenVideoPath,
						displayMediaHandle: result.value.displayMediaHandle,
					});
				} else {
					commitFailureIndices.push(i);
				}
			}

			if (commitFailureIndices.length > 0) {
				// Roll back any that did commit + discard any prepared but
				// uncommitted display-media streams.
				await Promise.allSettled(success.map((s) => stopOneTarget(s, { discard: true })));
				for (let i = 0; i < prepared.length; i++) {
					if (commitResults[i].status === "rejected") {
						discardOneTarget(prepared[i]);
					}
				}
				throw (
					aggregateLayerErrors(commitResults, "commit") ?? new Error("Multi-source commit failed.")
				);
			}

			return makeHandle(sessionId, layerIds, success);
		},
		async discard() {
			if (consumed) return;
			consumed = true;
			for (const p of prepared) discardOneTarget(p);
		},
	};
}

/**
 * One-shot start: prepare + commit in sequence. Existing call sites that
 * do not want pre-warm semantics keep using this.
 */
export async function startMultiSourceRecording(
	targets: MultiSourceTarget[],
	options?: { sessionId?: string },
): Promise<MultiSourceRecordingHandle> {
	const prepared = await prepareMultiSourceRecording(targets, options);
	try {
		return await prepared.commit();
	} catch (error) {
		await prepared.discard().catch(() => {
			// Best-effort cleanup; rethrow the original commit error.
		});
		throw error;
	}
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
			const results = await Promise.allSettled(active.map((s) => pauseOneTarget(s)));
			const err = aggregateLayerErrors(results, "pause");
			if (err) throw err;
		},
		async resumeAll() {
			if (!alive) throw new Error("Multi-source recording is no longer active.");
			const results = await Promise.allSettled(active.map((s) => resumeOneTarget(s)));
			const err = aggregateLayerErrors(results, "resume");
			if (err) throw err;
		},
		async stopAll(stopOptions) {
			if (!alive) throw new Error("Multi-source recording is no longer active.");
			alive = false;

			const stopResults = await Promise.allSettled(
				active.map((s) => stopOneTarget(s, stopOptions)),
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
	if (target.platform === "darwin") {
		const macSource = target.request.source;
		return macSource.type === "window" ? "window" : "screen";
	}
	// display-media is always a window capture (desktopCapturer source id
	// can target screens too, but the Phase 7 flow only routes window
	// layers through this path).
	return "window";
}
