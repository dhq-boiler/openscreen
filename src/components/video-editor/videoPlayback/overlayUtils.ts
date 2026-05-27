import { getZoomScale, type ZoomFocus, type ZoomRegion } from "../types";

interface OverlayUpdateParams {
	overlayEl: HTMLDivElement;
	indicatorEl: HTMLDivElement;
	region: ZoomRegion | null;
	focusOverride?: ZoomFocus;
	videoSize: { width: number; height: number };
	baseScale: number;
}

export function updateOverlayIndicator(params: OverlayUpdateParams) {
	// overlayEl.style.pointerEvents is intentionally NOT touched here ---
	// the wrapper stays `pointer-events: none` so Layer 1/2/3 stay draggable.
	// The caller controls indicatorEl.style.pointerEvents via a useEffect
	// keyed on selectedZoom + isPlaying (pinch the green tile to drag focus).
	const { overlayEl, indicatorEl, region, focusOverride, videoSize, baseScale } = params;

	if (!region || region.focusMode === "auto") {
		indicatorEl.style.display = "none";
		return;
	}

	const stageWidth = overlayEl.clientWidth;
	const stageHeight = overlayEl.clientHeight;

	if (!stageWidth || !stageHeight) {
		indicatorEl.style.display = "none";
		return;
	}

	if (!videoSize.width || !videoSize.height || baseScale <= 0) {
		indicatorEl.style.display = "none";
		return;
	}

	const zoomScale = getZoomScale(region);
	const focus = focusOverride ?? region.focus;

	// Zoom window shows the stage area that will be visible after zooming (1/zoomScale of stage dimensions)
	const indicatorWidth = stageWidth / zoomScale;
	const indicatorHeight = stageHeight / zoomScale;

	// The green tile may extend past Layer 1's rect so it can overlay
	// Layer 2 / 3 when focus is near a Layer 1 edge. The overlay wrapper
	// stays overflow:visible; outerWrapperRef (the editor canvas) still
	// clips to the user-visible preview --- that's the right outer bound.
	const adjustedLeft = focus.cx * stageWidth - indicatorWidth / 2;
	const adjustedTop = focus.cy * stageHeight - indicatorHeight / 2;

	indicatorEl.style.display = "block";
	indicatorEl.style.width = `${indicatorWidth}px`;
	indicatorEl.style.height = `${indicatorHeight}px`;
	indicatorEl.style.left = `${adjustedLeft}px`;
	indicatorEl.style.top = `${adjustedTop}px`;
}
