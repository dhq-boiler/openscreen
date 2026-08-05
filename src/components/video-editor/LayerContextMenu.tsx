import { useEffect, useRef } from "react";

export type LayerReorderDirection = "back" | "backward" | "forward" | "front";

interface LayerContextMenuProps {
	x: number;
	y: number;
	onReorder: (direction: LayerReorderDirection) => void;
	onClose: () => void;
}

interface MenuItem {
	direction: LayerReorderDirection;
	label: string;
}

const MENU_ITEMS: MenuItem[] = [
	{ direction: "front", label: "最前面へ移動" },
	{ direction: "forward", label: "前面へ移動" },
	{ direction: "backward", label: "背面へ移動" },
	{ direction: "back", label: "最背面へ移動" },
];

export function LayerContextMenu({ x, y, onReorder, onClose }: LayerContextMenuProps) {
	const menuRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const handleDown = (e: MouseEvent) => {
			if (!menuRef.current) return;
			if (!menuRef.current.contains(e.target as Node)) {
				onClose();
			}
		};
		const handleKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("mousedown", handleDown);
		document.addEventListener("keydown", handleKey);
		return () => {
			document.removeEventListener("mousedown", handleDown);
			document.removeEventListener("keydown", handleKey);
		};
	}, [onClose]);

	return (
		<div
			ref={menuRef}
			className="fixed z-[1000] min-w-[160px] rounded-md border border-white/10 bg-[#141519] py-1 text-[12px] text-white shadow-2xl"
			style={{ left: x, top: y }}
			onContextMenu={(e) => e.preventDefault()}
		>
			{MENU_ITEMS.map((item) => (
				<button
					key={item.direction}
					type="button"
					className="block w-full px-3 py-1.5 text-left hover:bg-white/[0.08]"
					onMouseDown={(e) => e.stopPropagation()}
					onClick={(e) => {
						e.stopPropagation();
						onReorder(item.direction);
						onClose();
					}}
				>
					{item.label}
				</button>
			))}
		</div>
	);
}
