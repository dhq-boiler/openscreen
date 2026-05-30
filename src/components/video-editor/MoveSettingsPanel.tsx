import { ArrowLeftRight, Crosshair, SkipBack, SkipForward, Trash2 } from "lucide-react";
import { useId, useMemo } from "react";
import { Button } from "@/components/ui/button";
import type { LayerTransform } from "./projectPersistence";
import type { MoveRegion } from "./types";

export interface MoveRect {
	cx: number;
	cy: number;
	width: number;
	height: number;
}

interface MoveSettingsPanelProps {
	region: MoveRegion;
	layerLabel: string;
	/** Static layer transform — used for "snap from/to current" buttons. */
	baseTransform?: LayerTransform | null;
	onFromChange: (next: MoveRect) => void;
	onToChange: (next: MoveRect) => void;
	/** Called on input blur / button release so the edit lands as one undo step. */
	onCommit?: () => void;
	onJumpToStart: () => void;
	onJumpToEnd: () => void;
	onDelete: () => void;
}

function formatTime(ms: number): string {
	const s = ms / 1000;
	const min = Math.floor(s / 60);
	const sec = s % 60;
	return min > 0 ? `${min}:${sec.toFixed(2).padStart(5, "0")}` : `${sec.toFixed(2)}s`;
}

function clampSize(n: number): number {
	if (!Number.isFinite(n)) return 0.05;
	return Math.max(0.05, Math.min(5, n));
}

function clampPosition(n: number): number {
	if (!Number.isFinite(n)) return 0.5;
	return Math.max(-2, Math.min(3, n));
}

/**
 * Inline editor for one of the two ends of a MoveRegion (from or to).
 * Displays cx/cy as % stage and width/height as % stage. Out-of-stage
 * values are allowed (clamped to a generous range) because Layers can
 * legitimately overflow the wallpaper.
 */
function RectEditor({
	title,
	rect,
	onChange,
	onCommit,
	onSnap,
	snapLabel,
}: {
	title: string;
	rect: MoveRect;
	onChange: (next: MoveRect) => void;
	onCommit?: () => void;
	onSnap?: () => void;
	snapLabel?: string;
}) {
	const idCx = useId();
	const idCy = useId();
	const idW = useId();
	const idH = useId();

	const fields: Array<{
		id: string;
		label: string;
		value: number;
		setNext: (raw: number) => MoveRect;
	}> = [
		{
			id: idCx,
			label: "x (%)",
			value: rect.cx * 100,
			setNext: (raw) => ({ ...rect, cx: clampPosition(raw / 100) }),
		},
		{
			id: idCy,
			label: "y (%)",
			value: rect.cy * 100,
			setNext: (raw) => ({ ...rect, cy: clampPosition(raw / 100) }),
		},
		{
			id: idW,
			label: "w (%)",
			value: rect.width * 100,
			setNext: (raw) => ({ ...rect, width: clampSize(raw / 100) }),
		},
		{
			id: idH,
			label: "h (%)",
			value: rect.height * 100,
			setNext: (raw) => ({ ...rect, height: clampSize(raw / 100) }),
		},
	];

	return (
		<div className="rounded-lg border border-white/10 bg-white/5 p-3">
			<div className="mb-2 flex items-center justify-between">
				<span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
					{title}
				</span>
				{onSnap && (
					<button
						type="button"
						onClick={onSnap}
						className="flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-white/10 hover:text-white transition-colors"
						title={snapLabel}
					>
						<Crosshair className="h-3 w-3" />
						<span>{snapLabel ?? "Snap"}</span>
					</button>
				)}
			</div>
			<div className="grid grid-cols-2 gap-2">
				{fields.map((field) => (
					<label key={field.id} htmlFor={field.id} className="flex flex-col gap-1">
						<span className="text-[10px] font-medium text-slate-500">{field.label}</span>
						<input
							id={field.id}
							type="number"
							step="0.5"
							inputMode="decimal"
							value={Number.isFinite(field.value) ? field.value.toFixed(2) : ""}
							onChange={(e) => {
								const next = Number(e.target.value);
								if (!Number.isFinite(next)) return;
								onChange(field.setNext(next));
							}}
							onBlur={() => onCommit?.()}
							className="h-7 rounded-md border border-white/10 bg-black/40 px-2 text-[11px] tabular-nums text-slate-100 outline-none focus:border-[#a78bfa]/60 focus:ring-1 focus:ring-[#a78bfa]/40"
						/>
					</label>
				))}
			</div>
		</div>
	);
}

export function MoveSettingsPanel({
	region,
	layerLabel,
	baseTransform,
	onFromChange,
	onToChange,
	onCommit,
	onJumpToStart,
	onJumpToEnd,
	onDelete,
}: MoveSettingsPanelProps) {
	const timeLabel = useMemo(
		() => `${formatTime(region.startMs)} – ${formatTime(region.endMs)}`,
		[region.startMs, region.endMs],
	);
	const durationLabel = useMemo(
		() => `${((region.endMs - region.startMs) / 1000).toFixed(2)}s`,
		[region.startMs, region.endMs],
	);

	const handleSwap = () => {
		const oldFrom = region.from;
		onFromChange({
			cx: region.to.cx,
			cy: region.to.cy,
			width: region.to.width,
			height: region.to.height,
		});
		onToChange({
			cx: oldFrom.cx,
			cy: oldFrom.cy,
			width: oldFrom.width,
			height: oldFrom.height,
		});
		onCommit?.();
	};

	const handleSnapFromCurrent = baseTransform
		? () => {
				onFromChange({
					cx: baseTransform.position.cx,
					cy: baseTransform.position.cy,
					width: baseTransform.size.width,
					height: baseTransform.size.height,
				});
				onCommit?.();
			}
		: undefined;

	const handleSnapToCurrent = baseTransform
		? () => {
				onToChange({
					cx: baseTransform.position.cx,
					cy: baseTransform.position.cy,
					width: baseTransform.size.width,
					height: baseTransform.size.height,
				});
				onCommit?.();
			}
		: undefined;

	return (
		<div className="min-w-0 p-4 flex flex-col h-full overflow-y-auto custom-scrollbar gap-3">
			<div>
				<span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
					Layer move
				</span>
				<div className="mt-1 text-xl font-semibold text-slate-100">{layerLabel}</div>
				<div className="mt-1 flex items-center gap-2 text-[11px] tabular-nums text-slate-400">
					<span>{timeLabel}</span>
					<span className="text-slate-600">•</span>
					<span>{durationLabel}</span>
				</div>
			</div>

			<div className="grid grid-cols-2 gap-2">
				<Button
					type="button"
					variant="ghost"
					onClick={onJumpToStart}
					className="h-8 rounded-md border border-white/10 bg-white/5 text-[11px] text-slate-300 hover:bg-white/10 hover:text-white"
				>
					<SkipBack className="mr-1 h-3 w-3" />
					Jump to start
				</Button>
				<Button
					type="button"
					variant="ghost"
					onClick={onJumpToEnd}
					className="h-8 rounded-md border border-white/10 bg-white/5 text-[11px] text-slate-300 hover:bg-white/10 hover:text-white"
				>
					<SkipForward className="mr-1 h-3 w-3" />
					Jump to end
				</Button>
			</div>

			<RectEditor
				title="From"
				rect={region.from}
				onChange={onFromChange}
				onCommit={onCommit}
				onSnap={handleSnapFromCurrent}
				snapLabel="Use current"
			/>
			<RectEditor
				title="To"
				rect={region.to}
				onChange={onToChange}
				onCommit={onCommit}
				onSnap={handleSnapToCurrent}
				snapLabel="Use current"
			/>

			<Button
				type="button"
				variant="ghost"
				onClick={handleSwap}
				className="h-8 rounded-md border border-white/10 bg-white/5 text-[11px] text-slate-300 hover:bg-white/10 hover:text-white"
			>
				<ArrowLeftRight className="mr-1 h-3 w-3" />
				Swap From ↔ To
			</Button>

			<div className="mt-auto pt-2">
				<Button
					type="button"
					variant="ghost"
					onClick={onDelete}
					className="w-full h-8 rounded-md border border-[#ef4444]/30 bg-[#ef4444]/10 text-[11px] text-[#fca5a5] hover:bg-[#ef4444]/20 hover:text-white"
				>
					<Trash2 className="mr-1 h-3 w-3" />
					Delete move
				</Button>
			</div>
		</div>
	);
}
