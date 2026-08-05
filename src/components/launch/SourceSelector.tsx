import { useEffect, useMemo, useState } from "react";
import { MdCheck } from "react-icons/md";
import { useScopedT } from "@/contexts/I18nContext";
import { Button } from "../ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import styles from "./SourceSelector.module.css";

interface DesktopSource {
	id: string;
	name: string;
	thumbnail: string | null;
	display_id: string;
	appIcon: string | null;
}

interface ProcessGroup {
	processKey: string; // stable "<pid>|<processName>" key
	pid: number;
	processName: string;
	processPath: string;
	// Preview only — process capture at record time uses PID directly and
	// picks up windows dialog-and-all, including ones desktopCapturer never
	// lists and ones that appear mid-recording.
	previewSources: DesktopSource[];
	windowCount: number; // count of enumerated windows (may exceed previewSources)
	sampleAppIcon: string | null;
	sampleThumbnail: string | null;
}

export function SourceSelector() {
	const t = useScopedT("launch");
	const tc = useScopedT("common");
	const [sources, setSources] = useState<DesktopSource[]>([]);
	const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
	const [processGroups, setProcessGroups] = useState<ProcessGroup[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;
		async function fetchSources() {
			setLoading(true);
			try {
				const rawSources = await window.electronAPI.getSources({
					types: ["screen", "window"],
					thumbnailSize: { width: 320, height: 180 },
					fetchWindowIcons: true,
				});
				const processed: DesktopSource[] = rawSources.map((source) => ({
					id: source.id,
					name:
						source.id.startsWith("window:") && source.name.includes(" — ")
							? source.name.split(" — ")[1] || source.name
							: source.name,
					thumbnail: source.thumbnail,
					display_id: source.display_id,
					appIcon: source.appIcon,
				}));
				if (cancelled) return;
				setSources(processed);

				// Process enumeration runs in parallel with the picker becoming
				// interactive. Failure just leaves the "Processes" tab empty;
				// the Screens / Windows tabs still work.
				try {
					const enumResult = await window.electronAPI.enumerateWindowsByProcess();
					if (cancelled) return;
					if ("windows" in enumResult) {
						const bySourceId = new Map(processed.map((s) => [s.id, s]));
						const groups = new Map<
							string,
							{
								group: ProcessGroup;
								countedHwnds: Set<number>;
							}
						>();
						for (const w of enumResult.windows) {
							// Skip the source-picker window itself (an Electron
							// child window) — it disappears at record time so
							// it would just clutter the picker.
							if (w.processName?.toLowerCase() === "openscreen.exe") continue;
							const key = `${w.pid}|${w.processName || "unknown"}`;
							let entry = groups.get(key);
							if (!entry) {
								entry = {
									group: {
										processKey: key,
										pid: w.pid,
										processName: w.processName || "Unknown",
										processPath: w.processPath || "",
										previewSources: [],
										windowCount: 0,
										sampleAppIcon: null,
										sampleThumbnail: null,
									},
									countedHwnds: new Set(),
								};
								groups.set(key, entry);
							}
							if (entry.countedHwnds.has(w.hwnd)) continue;
							entry.countedHwnds.add(w.hwnd);
							entry.group.windowCount += 1;

							// Attach a desktopCapturer preview if Chromium
							// happens to know this window. Dialogs / owned
							// popups usually don't appear here — that's fine,
							// they still get captured at record time via WGC.
							const known = bySourceId.get(w.sourceId);
							if (known) {
								entry.group.previewSources.push(known);
								if (!entry.group.sampleThumbnail && known.thumbnail) {
									entry.group.sampleThumbnail = known.thumbnail;
								}
								if (!entry.group.sampleAppIcon && known.appIcon) {
									entry.group.sampleAppIcon = known.appIcon;
								}
							}
						}
						setProcessGroups(
							Array.from(groups.values())
								.map((e) => e.group)
								.filter((g) => g.windowCount > 0)
								.sort((a, b) => {
									if (b.windowCount !== a.windowCount) {
										return b.windowCount - a.windowCount;
									}
									return a.processName.localeCompare(b.processName);
								}),
						);
					}
				} catch (enumError) {
					console.warn("Failed to enumerate windows by process:", enumError);
				}
			} catch (error) {
				console.error("Error loading sources:", error);
			} finally {
				if (!cancelled) setLoading(false);
			}
		}
		fetchSources();
		return () => {
			cancelled = true;
		};
	}, []);

	const screenSources = useMemo(() => sources.filter((s) => s.id.startsWith("screen:")), [sources]);
	const windowSources = useMemo(() => sources.filter((s) => s.id.startsWith("window:")), [sources]);
	// Synthetic sources built for process-tab selection. Their id has a
	// dedicated `process:` prefix so useScreenRecorder / handlers.ts can
	// route them through the process-capture orchestrator (records every
	// visible window of the pid + follows new dialogs mid-recording).
	const processSyntheticSources = useMemo<DesktopSource[]>(
		() =>
			processGroups.map((g) => ({
				id: `process:${g.pid}:${g.processName}`,
				name: g.processName,
				thumbnail: g.sampleThumbnail,
				display_id: "",
				appIcon: g.sampleAppIcon,
			})),
		[processGroups],
	);
	const sourcesById = useMemo(
		() => new Map([...sources, ...processSyntheticSources].map((s) => [s.id, s])),
		[sources, processSyntheticSources],
	);
	const selectedSources = useMemo(
		() =>
			selectedSourceIds
				.map((id) => sourcesById.get(id))
				.filter((s): s is DesktopSource => Boolean(s)),
		[selectedSourceIds, sourcesById],
	);

	const toggleSource = (source: DesktopSource) => {
		setSelectedSourceIds((prev) => {
			if (prev.includes(source.id)) {
				return prev.filter((id) => id !== source.id);
			}
			return [...prev, source.id];
		});
	};

	const toggleProcessGroup = (group: ProcessGroup) => {
		const processSourceId = `process:${group.pid}:${group.processName}`;
		setSelectedSourceIds((prev) => {
			if (prev.includes(processSourceId)) {
				return prev.filter((id) => id !== processSourceId);
			}
			return [...prev, processSourceId];
		});
	};

	const handleShare = async () => {
		if (selectedSources.length === 0) return;
		if (selectedSources.length === 1) {
			// Preserve the legacy single-source IPC path so existing recording
			// state machine in the main app keeps working unchanged.
			await window.electronAPI.selectSource(selectedSources[0]);
			return;
		}
		await window.electronAPI.selectSources(selectedSources);
	};

	if (loading) {
		return (
			<div
				className={`h-full flex items-center justify-center ${styles.glassContainer}`}
				style={{ minHeight: "100vh" }}
			>
				<div className="text-center">
					<div className="animate-spin duration-500 rounded-[50%] h-6 w-6 border-2 border-b-transparent border-[#34B27B] mx-auto mb-2" />
					<p className="text-xs text-zinc-400">{t("sourceSelector.loading")}</p>
				</div>
			</div>
		);
	}

	const renderSourceCard = (source: DesktopSource) => {
		const selectionIndex = selectedSourceIds.indexOf(source.id);
		const isSelected = selectionIndex !== -1;
		return (
			<div
				key={source.id}
				className={`${styles.sourceCard} ${isSelected ? styles.selected : ""} p-1.5`}
				onClick={() => toggleSource(source)}
			>
				<div className="relative mb-1.5 overflow-hidden rounded-lg border border-white/[0.06] bg-black/30">
					<img
						src={source.thumbnail || ""}
						alt={source.name}
						className="w-full aspect-video object-cover"
					/>
					{isSelected && (
						<div className="absolute right-1.5 top-1.5">
							<div className={styles.checkBadge}>
								{selectedSources.length > 1 ? (
									<span className="text-[10px] font-semibold text-white px-1">
										{selectionIndex + 1}
									</span>
								) : (
									<MdCheck size={11} className="text-white" />
								)}
							</div>
						</div>
					)}
				</div>
				<div className="flex items-center gap-1.5 px-1 pb-0.5">
					{source.appIcon && (
						<img src={source.appIcon} alt="" className={`${styles.icon} flex-shrink-0`} />
					)}
					<div className={`${styles.name} truncate`}>{source.name}</div>
				</div>
			</div>
		);
	};

	const renderProcessCard = (group: ProcessGroup) => {
		const processSourceId = `process:${group.pid}:${group.processName}`;
		const isSelected = selectedSourceIds.includes(processSourceId);
		return (
			<div
				key={group.processKey}
				className={`${styles.sourceCard} ${isSelected ? styles.selected : ""} p-1.5`}
				onClick={() => toggleProcessGroup(group)}
				title={group.processPath || group.processName}
			>
				<div className="relative mb-1.5 overflow-hidden rounded-lg border border-white/[0.06] bg-black/30">
					{group.sampleThumbnail ? (
						<img
							src={group.sampleThumbnail}
							alt={group.processName}
							className="w-full aspect-video object-cover opacity-80"
						/>
					) : (
						<div className="w-full aspect-video" />
					)}
					{isSelected && (
						<div className="absolute right-1.5 top-1.5">
							<div className={styles.checkBadge}>
								<MdCheck size={11} className="text-white" />
							</div>
						</div>
					)}
					<div className="absolute left-1.5 bottom-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
						{t("sourceSelector.processWindowCount", { count: String(group.windowCount) })}
					</div>
				</div>
				<div className="flex items-center gap-1.5 px-1 pb-0.5">
					{group.sampleAppIcon && (
						<img src={group.sampleAppIcon} alt="" className={`${styles.icon} flex-shrink-0`} />
					)}
					<div className={`${styles.name} truncate`}>{group.processName}</div>
				</div>
			</div>
		);
	};

	const selectionHint =
		selectedSources.length > 1
			? t("sourceSelector.selectionHint", { count: String(selectedSources.length) })
			: null;

	const showProcessesTab = processGroups.length > 0;
	const defaultTab =
		screenSources.length === 0 ? (showProcessesTab ? "processes" : "windows") : "screens";

	return (
		<div className={`min-h-screen flex flex-col ${styles.glassContainer}`}>
			<div className="flex-1 flex flex-col w-full px-3.5 pt-3.5">
				<Tabs defaultValue={defaultTab} className="flex-1 flex flex-col">
					<TabsList
						className={`mb-3 grid h-8 ${
							showProcessesTab ? "grid-cols-3" : "grid-cols-2"
						} rounded-xl border border-white/[0.06] bg-white/[0.04] p-0.5`}
					>
						<TabsTrigger
							value="screens"
							className="rounded-lg py-1 text-[11px] text-zinc-400 transition-all data-[state=active]:bg-white/[0.12] data-[state=active]:text-white"
						>
							{t("sourceSelector.screens", { count: String(screenSources.length) })}
						</TabsTrigger>
						<TabsTrigger
							value="windows"
							className="rounded-lg py-1 text-[11px] text-zinc-400 transition-all data-[state=active]:bg-white/[0.12] data-[state=active]:text-white"
						>
							{t("sourceSelector.windows", { count: String(windowSources.length) })}
						</TabsTrigger>
						{showProcessesTab && (
							<TabsTrigger
								value="processes"
								className="rounded-lg py-1 text-[11px] text-zinc-400 transition-all data-[state=active]:bg-white/[0.12] data-[state=active]:text-white"
							>
								{t("sourceSelector.processes", { count: String(processGroups.length) })}
							</TabsTrigger>
						)}
					</TabsList>
					<div className="flex-1 min-h-0">
						<TabsContent value="screens" className="h-full mt-0">
							<div
								className={`grid h-[282px] auto-rows-min grid-cols-2 gap-2.5 overflow-y-auto pr-1.5 pt-1 ${styles.sourceGridScroll}`}
							>
								{screenSources.map(renderSourceCard)}
							</div>
						</TabsContent>
						<TabsContent value="windows" className="h-full mt-0">
							<div
								className={`grid h-[282px] auto-rows-min grid-cols-2 gap-2.5 overflow-y-auto pr-1.5 pt-1 ${styles.sourceGridScroll}`}
							>
								{windowSources.map(renderSourceCard)}
							</div>
						</TabsContent>
						{showProcessesTab && (
							<TabsContent value="processes" className="h-full mt-0">
								<div
									className={`grid h-[282px] auto-rows-min grid-cols-2 gap-2.5 overflow-y-auto pr-1.5 pt-1 ${styles.sourceGridScroll}`}
								>
									{processGroups.map(renderProcessCard)}
								</div>
							</TabsContent>
						)}
					</div>
				</Tabs>
			</div>
			{selectionHint ? (
				<div className="px-3 pb-1 text-center text-[10px] text-zinc-400">{selectionHint}</div>
			) : null}
			<div className="flex justify-center gap-2 border-t border-white/[0.06] p-3">
				<Button
					data-testid="source-selector-cancel-button"
					variant="ghost"
					onClick={() => window.close()}
					className="h-8 rounded-lg px-5 text-[11px] text-zinc-400 transition-transform duration-150 hover:bg-white/5 hover:text-white active:scale-95"
				>
					{tc("actions.cancel")}
				</Button>
				<Button
					data-testid="source-selector-share-button"
					onClick={handleShare}
					disabled={selectedSources.length === 0}
					className="h-8 rounded-lg bg-[#34B27B] px-5 text-[11px] font-semibold text-white transition-transform duration-150 hover:bg-[#34B27B]/85 active:scale-95 disabled:bg-zinc-700 disabled:opacity-30"
				>
					{tc("actions.share")}
				</Button>
			</div>
		</div>
	);
}
