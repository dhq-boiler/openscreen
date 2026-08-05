import type { Span } from "dnd-timeline";
import { useItem } from "dnd-timeline";

interface LayerLifespanBarProps {
	id: string;
	rowId: string;
	span: Span;
	label?: string;
}

/**
 * Read-only bar showing when an additional layer's recording covers the
 * composed timeline. Non-editable — a mid-recording dialog's lifespan is
 * dictated by when it appeared and disappeared during capture, not by user
 * edit. Uses `useItem` only for positioning, no drag / resize listeners
 * are attached.
 */
export default function LayerLifespanBar({ id, rowId, span, label }: LayerLifespanBarProps) {
	const { setNodeRef, itemStyle } = useItem({ id, span, data: { rowId } });
	return (
		<div ref={setNodeRef} style={{ ...itemStyle, pointerEvents: "none" }}>
			<div
				className="w-full h-[8px] rounded-sm"
				style={{
					background: "linear-gradient(180deg, rgba(120,180,255,0.55), rgba(80,140,220,0.45))",
					border: "1px solid rgba(120,180,255,0.35)",
					marginTop: 22,
				}}
				title={label ?? ""}
			/>
		</div>
	);
}
