# Multi-Window Recording Design

OpenScreen currently records a single source (display, window, or region) per session and edits it as a single video stream. This document proposes extending the product so a user can record **multiple windows simultaneously** as independent streams, then arrange them as **freely-positioned, individually-zoomable layers on a virtual desktop** inside the editor.

> Status: design draft. No code has been written against this design yet.

## Goals

- Record N independent windows (or displays) in parallel within a single recording session, each producing its own `.webm` file.
- In the editor, treat each recorded clip as a **video layer** that can be positioned, resized, reordered, and shown/hidden on a virtual desktop background (the existing wallpaper/gradient).
- Extend zoom/pan so a zoom region can target a specific layer ("zoom into Window B") rather than only stage-relative coordinates.
- Export a single composed MP4/GIF that contains all visible layers, the background, and all existing effects (annotations, blur, cursor highlights, etc.).
- Preserve backward compatibility: existing single-source projects open unchanged.

## Non-Goals

- Recording multiple **displays** simultaneously is in scope, but optimizing for >4 simultaneous sources is not — the initial target is 2–4 windows.
- No new capture backend. We reuse the existing WGC helper on Windows and ScreenCaptureKit helper on macOS. Each window = one helper process.
- No real-time multi-window preview composition inside the recorder UI. Live preview can show one source at a time during recording; the multi-layer composition is an editor-time concept.
- No timeline-level reordering of recordings (each layer always plays from t=0 of the recording session). Per-layer time offset/trim is a follow-up.

## Background

OpenScreen's pipeline today has three layers:

1. **Recording** (`useScreenRecorder.ts` + `electron/ipc/handlers.ts` + native helpers): single global recording session, single output file (`recording-<id>.webm`), optionally plus a webcam sidecar.
2. **Project model** (`projectPersistence.ts` + `recordingSession.ts`): `EditorProjectData.media: ProjectMedia` references a single `screenVideoPath` and optional `webcamVideoPath`. Effects (`ZoomRegion[]`, `TrimRegion[]`, `SpeedRegion[]`, `AnnotationRegion[]`) are already arrays but all reference the implicit single video.
3. **Editor / Export** (`VideoPlayback.tsx` + `videoPlayback/*` + `lib/exporter/*`): a single PixiJS `videoContainer` holds a single `videoSprite` sourced from a single `HTMLVideoElement`. Export decodes one stream and composes effects on top.

Two pieces of good news for this design:

- The native capture helper is invoked **per-process** (one `wgc-capture.exe` per recording). Spawning multiple helpers is mechanically possible — the constraint is only in the TypeScript glue.
- Effect regions are already arrays. We need to add a `layerId` field to each, but the storage shape doesn't change.

The bad news: the recording IPC layer (`handlers.ts`) holds global singletons (`nativeWindowsCaptureProcess`, `nativeMacCaptureProcess`, `cursorRecordingSession`, ...) and explicitly rejects a second `start-native-windows-recording` call. That's the main thing to unwind.

## Target Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Recording                                                       │
│                                                                 │
│  User selects multiple sources ──► useScreenRecorder            │
│   (window-A, window-B, ...)        ├─ spawns N helpers in       │
│                                    │  parallel via IPC          │
│                                    └─ collects N MediaPaths     │
│                                                                 │
│  Native side: N × wgc-capture.exe processes, one per source     │
│  Output:      N × recording-<sessionId>-<layerId>.webm          │
│               1 × recording-<sessionId>.session.json (manifest) │
├─────────────────────────────────────────────────────────────────┤
│ Project model                                                   │
│                                                                 │
│  ProjectMedia (v3):                                             │
│    layers: VideoLayer[]                                         │
│      ├─ id, screenVideoPath, sourceWidth/Height                 │
│      ├─ initialPosition (cx, cy ∈ [0,1])                        │
│      ├─ initialSize     (width, height ∈ [0,1])                 │
│      ├─ zOrder, hidden                                          │
│      └─ recordedAtMs (absolute, for cross-layer sync)           │
│    webcam?: WebcamLayer  (same shape, distinct role)            │
│                                                                 │
│  ZoomRegion / TrimRegion / etc. gain optional layerId.          │
│  Missing layerId means "applies to whole composition".          │
├─────────────────────────────────────────────────────────────────┤
│ Editor / Export                                                 │
│                                                                 │
│  PixiJS stage:                                                  │
│    cameraContainer (global zoom/pan)                            │
│      ├─ backgroundSprite (wallpaper)                            │
│      ├─ layerContainer[0..N]   ← one per VideoLayer             │
│      │    ├─ videoSprite       (HTMLVideoElement → Texture)     │
│      │    ├─ maskGraphics      (rounded corners, shadow)        │
│      │    └─ perLayerCameraContainer (when zoomed into layer)   │
│      ├─ webcamContainer        (existing webcam overlay)        │
│      └─ overlayContainer       (cursor, annotations, blur)      │
│                                                                 │
│  Drag/resize UI: HTML overlay (react-rnd-style), one Rnd per    │
│  layer, mirroring the existing webcam-positioning pattern.      │
└─────────────────────────────────────────────────────────────────┘
```

## Data Model Changes

### `src/lib/recordingSession.ts`

```ts
// v3 — coexists with v2 via migration in projectPersistence
export interface VideoLayer {
  id: string;                  // stable uuid, used by ZoomRegion.layerId etc.
  kind: "screen" | "window";   // for UI labeling only; both go through WGC/SCK
  screenVideoPath: string;
  sourceWidth: number;         // pixel dimensions of the recording
  sourceHeight: number;
  recordedAtMs: number;        // wall-clock at session start (for inter-layer sync)
  sourceLabel?: string;        // e.g. window title at capture time
}

export interface WebcamLayer {
  webcamVideoPath: string;
  sourceWidth: number;
  sourceHeight: number;
}

export interface ProjectMediaV3 {
  schemaVersion: 3;
  sessionId: string;           // shared across all layers in this recording
  layers: VideoLayer[];        // 1..N
  webcam?: WebcamLayer;
}

// Existing single-source ProjectMedia kept as ProjectMediaV2 for migration.
export type ProjectMedia = ProjectMediaV2 | ProjectMediaV3;
```

### `src/components/video-editor/types.ts`

Add an optional `layerId` to region types:

```ts
export interface ZoomRegion {
  id: string;
  layerId?: string;            // NEW — undefined = full-stage zoom
  startMs: number;
  endMs: number;
  focus: { x: number; y: number };  // when layerId set, relative to that layer
  depth: number;
  motionBlur: number;
  // ... existing fields
}
```

`TrimRegion`, `SpeedRegion`, `AnnotationRegion`, `BlurRegion` similarly gain optional `layerId`. Regions without `layerId` continue to apply to the whole composition (this is what v2 projects look like after migration).

### `EditorProjectData` per-layer state

The persistent editor state needs per-layer transforms:

```ts
export interface LayerTransform {
  layerId: string;
  position: { cx: number; cy: number };   // 0..1, center of layer on stage
  size: { width: number; height: number }; // 0..1, fraction of stage
  rotation: number;                        // radians, 0 by default
  zOrder: number;
  visible: boolean;
  cornerRadius?: number;                   // per-layer override
}

export interface ProjectEditorStateV3 extends ProjectEditorStateV2 {
  layerTransforms: LayerTransform[];
  // crop/padding/shadow remain stage-global for v3.
}
```

## Recording Pipeline Changes

### Native helper: no contract change

`wgc-capture.exe` already accepts one `CaptureConfig` JSON per process and writes one output file. We do **not** need a new helper protocol — we just spawn N helpers.

The native side already supports a `recordingId` field, so the output filename and any cursor sidecars will not collide.

### `electron/ipc/handlers.ts`

Replace global singletons with maps keyed by `recordingId`:

```ts
// Before:
let nativeWindowsCaptureProcess: ChildProcess | null = null;
let nativeWindowsCaptureTargetPath: string | null = null;
let nativeWindowsCursorOffsetMs = 0;
const nativeWindowsPauseRanges: PauseRange[] = [];

// After:
interface NativeRecordingHandle {
  process: ChildProcess;
  targetPath: string;
  cursorOffsetMs: number;
  pauseRanges: PauseRange[];
  source: NativeWindowsSourceType;
  layerId: string;        // stable, mirrored in ProjectMedia.layers
}
const nativeWindowsCaptures = new Map<number, NativeRecordingHandle>();
```

IPC handlers that currently take "the recording" need a `recordingId` argument:

- `start-native-windows-recording` returns the assigned `recordingId` (it does today, we just stop overwriting).
- `stop-native-windows-recording(recordingId)`, `pause`/`resume`/`cancel` look up by id.

Same shape on macOS (`nativeMacCaptures`). Cursor recording sessions become `Map<recordingId, CursorRecordingSession>`. `electron/ipc/handlers.ts:760-798` (`startCursorRecording`/`stopCursorRecording`) is already structured around a single session and will need the same map treatment.

### `src/hooks/useScreenRecorder.ts`

Hot spots that must change:

- `useScreenRecorder.ts:82-93`: handle types become arrays/maps.
- `useScreenRecorder.ts:130-143`: refs (`nativeWindowsRecording`, `nativeMacRecording`, `screenRecorder`, `webcamRecorder`) become `Map<layerId, Handle>`.
- `useScreenRecorder.ts:152-156`: `canPauseRecording` becomes "any active handle".
- New input: a `sources: RecordingSourceSelection[]` prop instead of a single source. The UI calls `toggleRecording(sources)` with the user's multi-pick.
- Finalization (`finalizeRecording`, `useScreenRecorder.ts:357-416`) is already parameterized by handle — it just needs to be called per layer and the results aggregated into a single `ProjectMediaV3.layers`.

A single shared `sessionId` (one per "user pressed record") gets generated up front and stamped into every layer's filename and into `recording-<sessionId>.session.json`. This is what ties the layers together at edit time.

### Source-picker UI

Today the source picker is single-select. We extend it to multi-select with a small "Selected sources" list and a "Start" button that becomes enabled at 1..N selections. Visual design will be tracked separately; for v1 we can simply allow checkbox multi-select in the existing list.

## Project File Migration (v2 → v3)

```ts
function migrateMediaV2toV3(v2: ProjectMediaV2, sessionId: string): ProjectMediaV3 {
  return {
    schemaVersion: 3,
    sessionId,
    layers: [{
      id: uuid(),
      kind: "screen",
      screenVideoPath: v2.screenVideoPath,
      sourceWidth: v2.sourceWidth ?? 0,
      sourceHeight: v2.sourceHeight ?? 0,
      recordedAtMs: 0,
    }],
    webcam: v2.webcamVideoPath ? {
      webcamVideoPath: v2.webcamVideoPath,
      sourceWidth: v2.webcamSourceWidth ?? 0,
      sourceHeight: v2.webcamSourceHeight ?? 0,
    } : undefined,
  };
}
```

For `ProjectEditorState`, single-layer projects get a `LayerTransform` covering the full stage (`position = {0.5, 0.5}, size = {1, 1}`). This makes a v2 project visually identical after migration. The `PROJECT_VERSION` constant in `projectPersistence.ts:62` bumps from 2 to 3, and `normalizeProjectEditor` gets the new branch.

## Editor / Canvas Changes

### Stage structure

`src/components/video-editor/VideoPlayback.tsx:1008-1026` (the PixiJS stage build) gains a `layerContainer` array between `cameraContainer` and the leaf sprites. Each `layerContainer[i]` mirrors today's `videoContainer`: a Container with a video Sprite child and a mask Graphics child.

`layoutUtils.ts:40-110` (`layoutVideoContent`) needs to become per-layer. Rather than computing one rect for "the video," it iterates `layerTransforms`, applies each transform to its layer, and writes back position/scale for each layer's container.

### Zoom into a layer

`videoPlayback/zoomTransform.ts:75-107` and `zoomRegionUtils.ts:getResolvedFocus` currently compute focus relative to the single stage size. When `ZoomRegion.layerId` is set, focus must be resolved against that layer's current stage-space rect (post-transform). The existing camera container's scale/position math stays the same — we just feed it different anchor coordinates.

For the v1 of "zoom into layer," we only need to support stage-space camera animation that *happens to point at* a specific layer. We do **not** need per-layer cameras yet. That's a follow-up if users want "zoom inside Window A while Window B keeps showing at the corner unchanged."

### Drag/resize UI

The `AnnotationOverlay.tsx` + `react-rnd` pattern is the model: an HTML `<Rnd>` overlay per layer, sized to match the PixiJS layer's stage rect, with `onPositionChange` / `onSizeChange` writing back into `LayerTransform`. Webcam already does this in `VideoPlayback.tsx:721-765`. We essentially generalize that to N layers.

### Cursor data

Each layer has its own `cursor-<recordingId>.json` file produced by the cursor sampler. The existing `useCursorRecordingData` hook needs to become per-layer, and `cursorRenderer.ts` needs to render cursors into the correct layer's local coordinate space.

This is the place where multi-window adds real complexity: when the user looks at a composed video, each layer's cursor must move within the layer's frame, not the global stage frame. We map cursor positions through the layer's transform before drawing.

## Export Pipeline Changes

The export pipeline is the highest-risk area.

### Current flow

`src/lib/exporter/videoExporter.ts:159-487` → `StreamingVideoDecoder` (one) → `FrameRenderer.renderFrame(videoFrame)` (one) → `VideoEncoder` → `VideoMuxer`. The single `StreamingVideoDecoder` instance and the single-VideoFrame argument to `renderFrame` are the points to change.

### Proposed flow

```
streamingDecoders: StreamingVideoDecoder[]   // one per layer
                                              ▼
For each output frame at timestamp t:
  1. From each decoder, pull the frame whose presentation time best matches t
     (uses TimestampedVideoFrameQueue, already used for webcam)
  2. FrameRenderer.renderFrame({ layers: VideoFrame[], webcam, cursors, ... })
  3. PixiJS composes: background + layers (z-ordered) + cursors + annotations
  4. Read composite canvas → VideoEncoder.encode
  5. Close all VideoFrames
```

### Per-layer queues

`TimestampedVideoFrameQueue` already exists for webcam frame matching. We replicate it per layer. The queue backpressure (`videoExporter.ts:304-305`) becomes per-layer, with `Promise.all` for the wait condition.

### Memory budget

Each WebCodecs decoder holds ~50-100 MB of internal state. With 4 layers we're at ~400 MB just for decoders, plus ~12 frames × 4 layers in the queue (each frame is `4 * width * height` bytes for ARGB). A 1080p 12-deep queue per layer = ~12 × 4 × 8 MB = ~400 MB per layer for buffered frames.

Mitigations:
- Lower per-layer queue depth (e.g. 4 frames) when `layers.length > 2`.
- Decode at the *layer's final composed resolution*, not its native resolution, when that's smaller (typical case: layer occupies 1/4 of stage = decode at half resolution per axis).

### Stage as composition target

PixiJS keeps a single composite canvas. The single-`VideoFrame` assumption in `FrameRenderer.renderFrame()` (`frameRenderer.ts:381`) becomes a `{ layers: VideoFrame[], ... }` argument; the function iterates and uploads each frame to its layer's Sprite Texture.

### GIF path

`GifExporter` flows through the same `FrameRenderer`, so once `renderFrame` is layer-aware, GIF export gets multi-window support "for free." The `gif.js` worker remains untouched.

## Performance Considerations

| Concern | Estimate (4 layers @ 1080p60) | Mitigation |
|---|---|---|
| Concurrent WGC capture | ~4 × 5–8% CPU helper-side | Already separate processes — OS scheduler handles it. |
| Disk write throughput | ~4 × 30 MB/s peak = ~120 MB/s | NVMe handles easily. HDD users get a warning. |
| Live preview during recording | Only show one source at a time | Documented limitation for v1. |
| Editor playback (N HTMLVideoElements) | Chrome can decode ~3–4 1080p60 streams concurrently | Pause off-screen layers; cap N at 4 in UI. |
| Export decode queue memory | See "Memory budget" above | Adaptive queue depth. |
| Export wall-clock time | Linear in (number of layers × stage pixels) | Acceptable — export was already CPU-bound. |

## Open Questions

1. **Cross-layer time alignment.** All layers in one recording session share the same `recordedAtMs` start, but the helpers don't all begin encoding at the same instant. We need to confirm whether wgc-capture writes presentation timestamps that are wall-clock-aligned or session-relative. If session-relative, we may need a small calibration offset per layer.
2. **Live preview composition.** v1 punts on multi-layer live preview. If that turns out to be a serious UX gap, we may need to add a lightweight "show composed thumbnail" path during recording.
3. **Audio mixing.** Each layer's helper captures its own system audio loopback. Recording the same loopback from 4 helpers would result in 4× volume in the mix. For v1: only the first layer captures audio; others are video-only. Long-term, audio should be hoisted out of per-layer helpers into a single shared audio path.
4. **Per-layer cursors at export time.** The cursor renderer needs to know the layer's transform to draw cursors correctly. This is doable but adds a new dependency from the cursor renderer onto `LayerTransform`.
5. **Upstream contribution.** This is a sizable departure from the upstream single-layer assumption. Worth a design-doc PR to `siddharthvaddem/openscreen` before significant implementation work, in case the maintainer prefers a different shape.

## Incremental Implementation Plan

The plan is structured so each phase produces a runnable app and a working subset of the feature. We can stop at any phase boundary and still have something coherent.

### Phase 0 — Upstream bug fix (out of band)

Fix `electron/native/wgc-capture/src/main.cpp:635-636` (missing `control.` prefix on `stopRequested` and `cv.notify_all()`). Send as an independent PR to upstream. Already discovered during environment setup; tracked separately.

### Phase 1 — Native helper N-way capable (no UI change)

- Audit `electron/ipc/handlers.ts` global singletons. Convert to `Map<recordingId, Handle>`. Update all pause/resume/stop/cancel paths.
- Update `useScreenRecorder.ts` refs from singletons to `Map<layerId, Handle>`. Keep the public hook API single-source for now; internally route everything through the map with a single entry.
- Verify single-source recording still works end to end.

**Exit criteria:** all existing tests pass, single-window record/edit/export flow unchanged.

### Phase 2 — Source picker multi-select + parallel record

- Source-picker UI: add multi-select mode.
- `toggleRecording(sources: RecordingSourceSelection[])` spawns N helpers in parallel, awaits all to finalize, returns N `RecordedVideoAssetInput`.
- Write the v3 session manifest with `layers: [...]`.
- Project loader recognizes v3 manifest. Editor displays the **first** layer only (others ignored). Not user-visible yet.

**Exit criteria:** recording UI lets you check 2 windows, both record, both files land in `recording/`, project file lists both. Editor still shows only first one.

### Phase 3 — Editor: render N layers without per-layer interaction

- `VideoPlayback.tsx` builds `layerContainer[i]` for each layer.
- Default `LayerTransform` lays out layers in a simple grid (1, 2 horizontal, 2x2, etc. for N ≤ 4).
- Export composites N layers into one MP4/GIF.
- Single-layer projects unchanged (single-layer code path remains the default).

**Exit criteria:** record 2 windows → editor shows both side-by-side → export produces a single video with both visible.

### Phase 4 — Drag/resize/reorder layers

- HTML `<Rnd>` overlay per layer.
- `LayerTransform` mutations push into `useEditorHistory` (so undo/redo works).
- Z-order reordering UI (drag in a layer panel, or front/back buttons on selection).

**Exit criteria:** user can manually arrange the layers into any composition.

### Phase 5 — Zoom into a specific layer

- `ZoomRegion.layerId` optional.
- Zoom region creation UI offers "zoom into layer" alongside the existing "zoom into region."
- `zoomTransform.ts` resolves focus relative to selected layer's stage rect.

**Exit criteria:** user can add a zoom region that frames a specific layer, animation is smooth, single-layer projects behave identically.

### Phase 6 — Audio, cursor, polish

- Hoist audio capture out of per-layer helpers into a single shared session.
- Per-layer cursor rendering at export time.
- Performance work: adaptive queue depth, pause off-screen layers.

---

## Appendix: File Touch List

| File | Change |
|---|---|
| `electron/ipc/handlers.ts` | singletons → maps; cursor session map; IPC handlers take `recordingId` |
| `electron/native/wgc-capture/src/main.cpp` | no functional change (one process = one capture stays) |
| `src/hooks/useScreenRecorder.ts` | handle refs → maps; multi-source startup; aggregate finalize |
| `src/lib/nativeWindowsRecording.ts` | `NativeWindowsRecordingRequest` may need `layerId` to disambiguate |
| `src/lib/nativeMacRecording.ts` | same as above |
| `src/lib/recordingSession.ts` | `ProjectMediaV3`, `VideoLayer`, migration helpers |
| `src/components/video-editor/projectPersistence.ts` | `PROJECT_VERSION = 3`; v2→v3 migration; per-layer transform persistence |
| `src/components/video-editor/types.ts` | `layerId?` on regions; `LayerTransform` |
| `src/components/video-editor/VideoEditor.tsx` | layer state hooks; multi-layer playback orchestration |
| `src/components/video-editor/VideoPlayback.tsx` | N `videoContainer`s; per-layer event wiring |
| `src/components/video-editor/videoPlayback/layoutUtils.ts` | per-layer layout |
| `src/components/video-editor/videoPlayback/zoomTransform.ts` | `layerId`-aware focus resolution |
| `src/components/video-editor/videoPlayback/zoomRegionUtils.ts` | `layerId` propagation |
| `src/components/video-editor/videoPlayback/cursorRenderer.ts` | per-layer cursor mapping |
| `src/lib/exporter/videoExporter.ts` | N decoders; per-layer queue; multi-frame `renderFrame` |
| `src/lib/exporter/frameRenderer.ts` | layer-aware composition |
| `src/lib/exporter/streamingDecoder.ts` | no structural change; instantiated N times |
| `src/lib/exporter/gifExporter.ts` | benefits from `FrameRenderer` changes transparently |
| New: `src/components/video-editor/LayerPanel.tsx` | list/reorder/show-hide UI |
| New: `src/components/recorder/MultiSourcePicker.tsx` | multi-select source UI |
