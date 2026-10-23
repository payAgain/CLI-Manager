import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitFileDiffPayload } from "../../../lib/gitTransport";
import type { GitDiffOptions } from "../../../lib/gitDiffOptions";
import { useI18n } from "../../../lib/i18n";
import type { GitTreeNode } from "../../../lib/types";
import { useSettingsStore } from "../../../stores/settingsStore";
import { GitDiffViewer } from "./GitDiffViewer";
import { GitDiffDialogFrame } from "./GitDiffDialogFrame";
import {
  buildGitDiffReviewTargets,
  reconcileReviewTargetIndex,
  type GitDiffHunkPlacement,
  type GitDiffReviewStatusFilter,
  type GitDiffReviewTarget,
} from "./reviewNavigation";
import type { GitDiffDataSource, GitDiffSelectedLine } from "./types";
import { getGitDiffApprovalStatus, gitDiffApprovalKey } from "../../../lib/gitDiffApproval";
import { useGitDiffApprovalStore } from "../../../stores/gitDiffApprovalStore";

interface GitDiffReviewDialogProps {
  open: boolean;
  onClose: () => void;
  repositoryPath: string;
  repositoryRelativePath?: string;
  approvalScope?: string;
  tree: GitTreeNode[];
  untrackedTree: GitTreeNode[];
  statusFilter: GitDiffReviewStatusFilter;
  initialFilePath: string;
  loadDiff: (filePath: string, status: string, options?: GitDiffOptions) => Promise<GitFileDiffPayload>;
  revertHunk: (filePath: string, diffText: string, hunkIndex: number) => Promise<void>;
  revertLines: (
    filePath: string,
    diffText: string,
    selectedLines: GitDiffSelectedLine[],
  ) => Promise<void>;
  onRequestDiscard: (path: string, name: string, status: string) => void;
  onOpenSource: (target: GitDiffReviewTarget, lineNumber?: number) => Promise<boolean>;
  onPin: (target: GitDiffReviewTarget) => Promise<boolean>;
}

export function GitDiffReviewDialog({
  open,
  onClose,
  repositoryPath,
  repositoryRelativePath,
  approvalScope,
  tree,
  untrackedTree,
  statusFilter,
  initialFilePath,
  loadDiff,
  revertHunk,
  revertLines,
  onRequestDiscard,
  onOpenSource,
  onPin,
}: GitDiffReviewDialogProps) {
  const { t } = useI18n();
  const gitDiffViewMode = useSettingsStore((state) => state.gitDiffViewMode);
  const gitDiffWrapLines = useSettingsStore((state) => state.gitDiffWrapLines);
  const gitDiffWhitespaceMode = useSettingsStore((state) => state.gitDiffWhitespaceMode);
  const gitDiffContextLines = useSettingsStore((state) => state.gitDiffContextLines);
  const updateSettings = useSettingsStore((state) => state.update);
  const diffOptions = useMemo<GitDiffOptions>(() => ({
    whitespace: gitDiffWhitespaceMode,
    contextLines: gitDiffContextLines,
  }), [gitDiffContextLines, gitDiffWhitespaceMode]);
  const allTargets = useMemo(() => buildGitDiffReviewTargets({
    tree,
    untrackedTree,
    statusFilter,
    repositoryPath,
    repositoryRelativePath,
  }), [repositoryPath, repositoryRelativePath, statusFilter, tree, untrackedTree]);
  const records = useGitDiffApprovalStore((state) => state.records);
  const fingerprints = useGitDiffApprovalStore((state) => state.fingerprints);
  const [pendingOnly, setPendingOnly] = useState(false);
  const [activeTargetId, setActiveTargetId] = useState<string | null>(null);
  const approvedIds = useMemo(() => new Set(approvalScope ? allTargets.filter((target) => {
    const key = gitDiffApprovalKey(approvalScope, target.filePath);
    return getGitDiffApprovalStatus(records[key], fingerprints[key]) === "approved";
  }).map((target) => target.id) : []), [allTargets, approvalScope, fingerprints, records]);
  // Keep the currently viewed file until a user action advances it. Verification alone must
  // never start a chain that reads every previously approved file in the repository.
  const targets = useMemo(() => pendingOnly ? allTargets.filter((target) => target.id === activeTargetId || !approvedIds.has(target.id)) : allTargets,
    [activeTargetId, allTargets, approvedIds, pendingOnly]);
  const [initialHunkPlacement, setInitialHunkPlacement] = useState<GitDiffHunkPlacement>("first");
  const previousIndexRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    const initialIndex = targets.findIndex((target) => target.filePath === initialFilePath);
    const nextIndex = initialIndex >= 0 ? initialIndex : 0;
    previousIndexRef.current = nextIndex;
    setInitialHunkPlacement("first");
    setActiveTargetId(targets[nextIndex]?.id ?? null);
  }, [initialFilePath, open, repositoryPath]);

  const activeIndex = reconcileReviewTargetIndex(
    targets,
    activeTargetId,
    previousIndexRef.current,
  );
  const activeTarget = activeIndex >= 0 ? targets[activeIndex] : null;

  useEffect(() => {
    if (!activeTarget) return;
    previousIndexRef.current = activeIndex;
    if (activeTarget.id !== activeTargetId) setActiveTargetId(activeTarget.id);
  }, [activeIndex, activeTarget, activeTargetId]);

  useEffect(() => {
    if (open && activeTargetId && allTargets.length === 0) onClose();
  }, [activeTargetId, onClose, open, allTargets.length]);

  const dataSource = useMemo<GitDiffDataSource>(() => ({
    kind: "live",
    load: (target) => loadDiff(target.filePath, target.status, diffOptions),
    mutations: {
      revertHunk: (target, content, hunkIndex) => (
        revertHunk(target.filePath, content, hunkIndex)
      ),
      revertLines: (target, content, lines) => revertLines(target.filePath, content, lines),
      requestDiscard: (target) => onRequestDiscard(
        target.filePath,
        target.fileName,
        target.status,
      ),
    },
  }), [diffOptions, loadDiff, onRequestDiscard, revertHunk, revertLines, tree, untrackedTree]);

  const handleDiffOptionsChange = useCallback(async (options: GitDiffOptions) => {
    if (options.whitespace !== gitDiffWhitespaceMode) {
      await updateSettings("gitDiffWhitespaceMode", options.whitespace);
    }
    if (options.contextLines !== gitDiffContextLines) {
      await updateSettings("gitDiffContextLines", options.contextLines);
    }
  }, [gitDiffContextLines, gitDiffWhitespaceMode, updateSettings]);

  const selectAdjacentFile = useCallback((offset: -1 | 1) => {
    const nextTarget = targets[activeIndex + offset];
    if (!nextTarget) return;
    previousIndexRef.current = activeIndex + offset;
    setInitialHunkPlacement(offset < 0 ? "last" : "first");
    setActiveTargetId(nextTarget.id);
  }, [activeIndex, targets]);

  const handleOpenSource = useCallback(async (
    target: GitDiffReviewTarget,
    lineNumber?: number,
  ) => {
    if (await onOpenSource(target, lineNumber)) onClose();
  }, [onClose, onOpenSource]);

  const handlePin = useCallback(async (target: GitDiffReviewTarget) => {
    if (await onPin(target)) onClose();
  }, [onClose, onPin]);

  const nextPending = useCallback(() => {
    if (!approvalScope) return;
    const state = useGitDiffApprovalStore.getState();
    const index = allTargets.findIndex((target) => target.id === activeTargetId);
    const ordered = [...allTargets.slice(index + 1), ...allTargets.slice(0, index)];
    const next = ordered.find((target) => {
      const key = gitDiffApprovalKey(approvalScope, target.filePath);
      return getGitDiffApprovalStatus(state.records[key], state.fingerprints[key]) !== "approved";
    });
    if (next) { setInitialHunkPlacement("first"); setActiveTargetId(next.id); }
    else if (pendingOnly) setActiveTargetId(null);
  }, [activeTargetId, allTargets, approvalScope, pendingOnly]);

  return (
    <GitDiffDialogFrame
      open={open}
      onClose={onClose}
      useTerminalTheme
      ariaLabel={t("git.diff.reviewDialogNamed", {
        fileName: activeTarget?.fileName ?? initialFilePath,
      })}
    >
      {approvalScope && <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 bg-surface-container-low px-3 py-2 text-xs text-text-secondary">
        <span>{t("git.approval.progress", { approved: approvedIds.size, total: allTargets.length })}</span>
        <label className="flex cursor-pointer items-center gap-2">
          <input type="checkbox" checked={pendingOnly} onChange={(event) => {
            setPendingOnly(event.target.checked);
            if (event.target.checked && activeTargetId && approvedIds.has(activeTargetId)) {
              setActiveTargetId(allTargets.find((target) => !approvedIds.has(target.id))?.id ?? null);
            }
          }} />
          {t("git.approval.pendingOnly")}
        </label>
      </div>}
      {!activeTarget && allTargets.length > 0 && <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-text-muted">
        <p>{t("git.approval.allReviewed")}</p>
        <button type="button" className="ui-focus-ring rounded px-3 py-2 hover:bg-surface-container-high" onClick={() => setPendingOnly(false)}>{t("git.approval.showAll")}</button>
        <button type="button" className="ui-focus-ring rounded px-3 py-2 hover:bg-surface-container-high" onClick={onClose}>{t("common.close")}</button>
      </div>}
      {activeTarget && (
        <GitDiffViewer
          key={activeTarget.id}
          target={activeTarget}
          dataSource={dataSource}
          onClose={onClose}
          useTerminalTheme
          viewMode={gitDiffViewMode}
          wrapLines={gitDiffWrapLines}
          diffOptions={diffOptions}
          onViewModeChange={(mode) => void updateSettings("gitDiffViewMode", mode)}
          onWrapLinesChange={(wrapLines) => void updateSettings("gitDiffWrapLines", wrapLines)}
          onDiffOptionsChange={(options) => void handleDiffOptionsChange(options)}
          review={{
            fileIndex: activeIndex,
            fileCount: targets.length,
            additions: activeTarget.additions,
            deletions: activeTarget.deletions,
            initialHunkPlacement,
            canNavigateToPreviousFile: activeIndex > 0,
            canNavigateToNextFile: activeIndex + 1 < targets.length,
            onNavigateToPreviousFile: () => selectAdjacentFile(-1),
            onNavigateToNextFile: () => selectAdjacentFile(1),
            onOpenSource: (lineNumber) => void handleOpenSource(activeTarget, lineNumber),
            onPin: () => void handlePin(activeTarget),
            approvalKey: approvalScope ? gitDiffApprovalKey(approvalScope, activeTarget.filePath) : undefined,
            onNextPending: approvalScope && (allTargets.length > 1 || pendingOnly) ? nextPending : undefined,
            onApproved: pendingOnly ? nextPending : undefined,
          }}
        />
      )}
    </GitDiffDialogFrame>
  );
}
