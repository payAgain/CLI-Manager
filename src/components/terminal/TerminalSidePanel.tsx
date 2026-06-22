import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { BarChart3, GitBranch } from "../icons";
import { TERM } from "../stats/termStatsUi";
import { TerminalStatsPanel } from "./TerminalStatsPanel";

const GitChangesPanel = lazy(() =>
  import("../git/GitChangesPanel").then((module) => ({ default: module.GitChangesPanel }))
);

export type TerminalSidePanelTab = "stats" | "git";

interface TerminalSidePanelProps {
  open: boolean;
  activeTab: TerminalSidePanelTab;
  activeSessionId: string | null;
  projectPath: string | null;
  onTabChange: (tab: TerminalSidePanelTab) => void;
}

const STORAGE_KEY = "cli-manager:terminal-side-panel-width";
const DEFAULT_WIDTH = 243;
const MIN_WIDTH = 243;
const MAX_WIDTH = 500;

function clampWidth(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));
}

function readStoredWidth(): number {
  if (typeof window === "undefined") return DEFAULT_WIDTH;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_WIDTH;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? clampWidth(parsed) : DEFAULT_WIDTH;
}

export function TerminalSidePanel({ open, activeTab, activeSessionId, projectPath, onTabChange }: TerminalSidePanelProps) {
  const [width, setWidth] = useState(readStoredWidth);
  const [dragging, setDragging] = useState(false);
  const widthRef = useRef(width);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(DEFAULT_WIDTH);
  const pendingWidthRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  useEffect(() => {
    if (!dragging) return;

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const commitPendingWidth = () => {
      if (pendingWidthRef.current === null) return;
      setWidth(pendingWidthRef.current);
      frameRef.current = null;
    };

    const handleMouseMove = (event: MouseEvent) => {
      pendingWidthRef.current = clampWidth(dragStartWidthRef.current + dragStartXRef.current - event.clientX);
      if (frameRef.current === null) {
        frameRef.current = window.requestAnimationFrame(commitPendingWidth);
      }
    };

    const handleMouseUp = () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      const finalWidth = clampWidth(pendingWidthRef.current ?? widthRef.current);
      pendingWidthRef.current = null;
      setWidth(finalWidth);
      window.localStorage.setItem(STORAGE_KEY, String(finalWidth));
      setDragging(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [dragging]);

  const handleResizeMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragStartXRef.current = event.clientX;
    dragStartWidthRef.current = widthRef.current;
    pendingWidthRef.current = widthRef.current;
    setDragging(true);
  }, []);

  if (!open) return null;

  const tabs = [
    { key: "stats" as const, label: "实时统计", icon: <BarChart3 size={12} strokeWidth={1.8} /> },
    { key: "git" as const, label: "Git 变更", icon: <GitBranch size={12} strokeWidth={1.8} /> },
  ];

  return (
    <aside
      className="relative flex shrink-0 flex-col overflow-hidden border-l border-border font-mono"
      style={{ width, minWidth: MIN_WIDTH, maxWidth: MAX_WIDTH, backgroundColor: TERM.bg }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整终端侧边面板宽度"
        title="拖拽调整侧边面板宽度"
        className={`absolute left-0 top-0 z-20 h-full w-2 -translate-x-1/2 cursor-col-resize transition-colors ${dragging ? "bg-primary/35" : "hover:bg-primary/25"}`}
        onMouseDown={handleResizeMouseDown}
      />

      <div className="flex shrink-0 gap-1 border-b px-2 py-1.5" style={{ borderColor: TERM.dim }}>
        {tabs.map((tab) => {
          const selected = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => onTabChange(tab.key)}
              className="ui-focus-ring flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 text-[11px] font-bold transition-colors"
              style={{
                color: selected ? TERM.cyan : TERM.dim,
                backgroundColor: selected ? `${TERM.cyan}18` : "transparent",
                border: `1px solid ${selected ? `${TERM.cyan}55` : "transparent"}`,
              }}
              aria-pressed={selected}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <TerminalStatsPanel activeSessionId={activeSessionId} open={open} visible={activeTab === "stats"} embedded />
        {activeTab === "git" && (
          <Suspense fallback={null}>
            <GitChangesPanel open={open} projectPath={projectPath} visible embedded />
          </Suspense>
        )}
      </div>
    </aside>
  );
}
