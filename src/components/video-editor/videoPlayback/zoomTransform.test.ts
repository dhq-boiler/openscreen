import { describe, expect, it } from "vitest";
import { computeZoomTransform, type LayerRect, resolveStageFocus } from "./zoomTransform";

const STAGE = { width: 1920, height: 1080 };
const BASE_MASK = { x: 0, y: 0, width: 1920, height: 1080 };

describe("resolveStageFocus", () => {
	it("returns the input focus unchanged when no layerId is supplied", () => {
		const result = resolveStageFocus(0.25, 0.75, undefined, undefined);
		expect(result).toEqual({ x: 0.25, y: 0.75 });
	});

	it("returns the input focus unchanged when layerRects is omitted", () => {
		const result = resolveStageFocus(0.25, 0.75, "layer-1", undefined);
		expect(result).toEqual({ x: 0.25, y: 0.75 });
	});

	it("returns the input focus unchanged when the layerId is unknown", () => {
		const layerRects = new Map<string, LayerRect>([
			["layer-1", { cx: 0.5, cy: 0.5, width: 1, height: 1 }],
		]);
		const result = resolveStageFocus(0.25, 0.75, "layer-missing", layerRects);
		expect(result).toEqual({ x: 0.25, y: 0.75 });
	});

	it("maps a layer-local center (0.5, 0.5) to the layer's stage center", () => {
		// Layer occupies the top-right quadrant of the stage.
		const layerRects = new Map<string, LayerRect>([
			["layer-1", { cx: 0.75, cy: 0.25, width: 0.5, height: 0.5 }],
		]);
		const result = resolveStageFocus(0.5, 0.5, "layer-1", layerRects);
		expect(result.x).toBeCloseTo(0.75);
		expect(result.y).toBeCloseTo(0.25);
	});

	it("maps a layer-local corner to the layer's stage corner", () => {
		const layerRects = new Map<string, LayerRect>([
			["layer-1", { cx: 0.75, cy: 0.25, width: 0.5, height: 0.5 }],
		]);
		// (0, 0) in layer = top-left corner of the layer rect on stage.
		const topLeft = resolveStageFocus(0, 0, "layer-1", layerRects);
		expect(topLeft.x).toBeCloseTo(0.5);
		expect(topLeft.y).toBeCloseTo(0);

		// (1, 1) in layer = bottom-right corner of the layer rect on stage.
		const bottomRight = resolveStageFocus(1, 1, "layer-1", layerRects);
		expect(bottomRight.x).toBeCloseTo(1);
		expect(bottomRight.y).toBeCloseTo(0.5);
	});

	it("falls back to passthrough when the layer rect has zero size", () => {
		const layerRects = new Map<string, LayerRect>([
			["layer-1", { cx: 0.5, cy: 0.5, width: 0, height: 0 }],
		]);
		const result = resolveStageFocus(0.3, 0.7, "layer-1", layerRects);
		expect(result).toEqual({ x: 0.3, y: 0.7 });
	});
});

describe("computeZoomTransform with layer-local focus", () => {
	it("matches the stage-global transform when no layerId is supplied", () => {
		const baseline = computeZoomTransform({
			stageSize: STAGE,
			baseMask: BASE_MASK,
			zoomScale: 2,
			focusX: 0.75,
			focusY: 0.25,
		});

		const withMissingLayer = computeZoomTransform({
			stageSize: STAGE,
			baseMask: BASE_MASK,
			zoomScale: 2,
			focusX: 0.75,
			focusY: 0.25,
			layerRects: new Map(),
		});

		expect(withMissingLayer).toEqual(baseline);
	});

	it("layer-local focus (0.5, 0.5) zooms to the layer's stage center", () => {
		// Layer in the top-right quadrant.
		const layerRects = new Map<string, LayerRect>([
			["layer-2", { cx: 0.75, cy: 0.25, width: 0.5, height: 0.5 }],
		]);

		const layerLocal = computeZoomTransform({
			stageSize: STAGE,
			baseMask: BASE_MASK,
			zoomScale: 2,
			focusX: 0.5,
			focusY: 0.5,
			layerId: "layer-2",
			layerRects,
		});

		// Should equal the stage-global transform that zooms to (0.75, 0.25).
		const expectedStageGlobal = computeZoomTransform({
			stageSize: STAGE,
			baseMask: BASE_MASK,
			zoomScale: 2,
			focusX: 0.75,
			focusY: 0.25,
		});

		expect(layerLocal.scale).toBeCloseTo(expectedStageGlobal.scale);
		expect(layerLocal.x).toBeCloseTo(expectedStageGlobal.x);
		expect(layerLocal.y).toBeCloseTo(expectedStageGlobal.y);
	});

	it("layer-local corner focus zooms to the layer corner on stage", () => {
		const layerRects = new Map<string, LayerRect>([
			["layer-2", { cx: 0.75, cy: 0.25, width: 0.5, height: 0.5 }],
		]);

		const cornerLocal = computeZoomTransform({
			stageSize: STAGE,
			baseMask: BASE_MASK,
			zoomScale: 2,
			focusX: 0,
			focusY: 0,
			layerId: "layer-2",
			layerRects,
		});

		// (0, 0) in layer = (0.5, 0) on stage (top-left of the rect).
		const expectedStageGlobal = computeZoomTransform({
			stageSize: STAGE,
			baseMask: BASE_MASK,
			zoomScale: 2,
			focusX: 0.5,
			focusY: 0,
		});

		expect(cornerLocal.x).toBeCloseTo(expectedStageGlobal.x);
		expect(cornerLocal.y).toBeCloseTo(expectedStageGlobal.y);
	});
});
