import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { Project, WorktreeRecord } from "../../lib/types";
import { useI18n, type TranslationKey } from "../../lib/i18n";
import { useWorktreeStore, type WorktreeRemovalPreflight } from "../../stores/worktreeStore";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";

export interface WorktreeRemoveTarget { project: Project; worktree: WorktreeRecord; }
interface WorktreeRemoveDialogProps {
  open: boolean;
  targets: WorktreeRemoveTarget[];
  onClose: () => void;
  onRemoved?: (ids: string[]) => void;
}
interface RemovalRow {
  target: WorktreeRemoveTarget;
  preflight?: WorktreeRemovalPreflight;
  error?: TranslationKey;
}

function removalErrorKey(error: unknown, fallback: TranslationKey): TranslationKey {
  const message = String(error);
  const code = /worktree_remove_[a-z_]+|worktree_[a-z_]+|project_not_found|bare_repository_unsupported/.exec(message)?.[0];
  const known: Record<string, TranslationKey> = {
    worktree_remove_changed: "worktree.remove.checkChanged",
    worktree_target_changed: "worktree.remove.checkChanged",
    worktree_remove_confirmation_required: "worktree.remove.confirmationRequired",
    worktree_remove_confirmation_expired: "worktree.remove.confirmationExpired",
    worktree_remove_changes_confirmation_required: "worktree.remove.changesConfirmationRequired",
    worktree_remove_locked: "worktree.remove.locked",
    worktree_remove_nested_worktree: "worktree.remove.nestedWorktree",
    worktree_remove_primary: "worktree.remove.primary",
    worktree_remove_path_missing: "worktree.remove.pathMissing",
    worktree_remove_sessions_unavailable: "worktree.remove.sessionsUnavailable",
    worktree_remove_sessions_running: "worktree.remove.sessionsRunning",
    worktree_remove_processes_running: "worktree.remove.externalProcessesAction",
    worktree_remove_wsl_sessions: "worktree.remove.wslSessions",
    worktree_remove_branch_in_use: "worktree.remove.branchInUse",
    worktree_remove_detached_branch: "worktree.remove.checkChanged",
    worktree_remove_unsupported_environment: "worktree.remove.unsupportedEnvironment",
    worktree_remove_inspection_failed: "worktree.remove.checkFailed",
    worktree_remove_busy: "worktree.remove.busy",
    worktree_not_registered: "worktree.remove.invalidTarget",
    worktree_branch_mismatch: "worktree.remove.invalidTarget",
    worktree_path_not_absolute: "worktree.remove.invalidTarget",
    project_not_found: "worktree.remove.invalidTarget",
    bare_repository_unsupported: "worktree.remove.unsupportedEnvironment",
  };
  if (code && known[code]) return known[code];
  if (/changed|stale|token/.test(message)) return "worktree.remove.checkChanged";
  return fallback;
}

/** Every removal surface shares a fresh review and explicit destructive choices. */
export function WorktreeRemoveDialog({ open, targets, onClose, onRemoved }: WorktreeRemoveDialogProps) {
  const { t } = useI18n();
  const preflightRemoval = useWorktreeStore(state => state.preflightRemoval);
  const removeWorktree = useWorktreeStore(state => state.removeWorktree);
  const [rows, setRows] = useState<RemovalRow[]>([]);
  const [checking, setChecking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [discardChanges, setDiscardChanges] = useState(false);
  const [closeSessions, setCloseSessions] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);
  const generation = useRef(0);
  const removingRef = useRef(false);
  const completedIds = useRef(new Set<string>());
  const activeTargets = useRef(targets);
  const targetKey = JSON.stringify(targets.map(({ project, worktree }) => [project.id, project.path, worktree.id, worktree.path, worktree.branch]));
  activeTargets.current = targets;

  const checkTargets = useCallback(async (items: WorktreeRemoveTarget[]) => {
    const currentGeneration = ++generation.current;
    setChecking(true);
    setDiscardChanges(false);
    setCloseSessions(false);
    setDeleteBranch(false);
    const pendingRows = items.filter(item => !completedIds.current.has(item.worktree.id));
    setRows(pendingRows.map(target => ({ target })));
    const nextRows = await Promise.all(pendingRows.map(async target => {
      try { return { target, preflight: await preflightRemoval(target.worktree) }; }
      catch (cause) { return { target, error: removalErrorKey(cause, "worktree.remove.checkFailed") }; }
    }));
    if (generation.current !== currentGeneration) return;
    setRows(nextRows);
    setChecking(false);
  }, [preflightRemoval]);

  useEffect(() => {
    if (!open) { generation.current += 1; return; }
    completedIds.current = new Set();
    setError(null);
    setDeleting(false);
    setProgress(0);
    void checkTargets(activeTargets.current);
    return () => { generation.current += 1; };
  }, [open, targetKey, checkTargets]);

  const dirty = rows.some(row => row.preflight?.dirty);
  const runningCount = rows.reduce((count, row) => count + (row.preflight?.runningSessions.length ?? 0), 0);
  const canDeleteBranch = rows.some(row => row.preflight && !row.preflight.detached && row.preflight.branch);
  const blocked = rows.length === 0 || rows.some(row => !row.preflight || row.error
    || row.preflight.locked || row.preflight.externalProcesses.length > 0);
  const canConfirm = !checking && !deleting && !blocked && (!dirty || discardChanges) && (!runningCount || closeSessions);
  const totalChanges = (item: WorktreeRemovalPreflight & { changedCount?: number }) => item.changedCount ?? item.changedPaths.length;
  const visibleRows = useMemo(() => rows.filter(row => !completedIds.current.has(row.target.worktree.id)), [rows]);

  const remove = async () => {
    if (!canConfirm || removingRef.current) return;
    removingRef.current = true;
    setDeleting(true);
    setError(null);
    let removed = 0;
    const ids: string[] = [];
    for (const row of visibleRows) {
      if (!row.preflight) break;
      setProgress(removed + 1);
      try {
        await removeWorktree(row.target.worktree, Boolean(deleteBranch && !row.preflight.detached && row.preflight.branch), {
          preflight: row.preflight, discardChanges, closeSessions,
        });
        completedIds.current.add(row.target.worktree.id);
        ids.push(row.target.worktree.id);
        removed += 1;
      } catch (cause) {
        setError(removalErrorKey(cause, "worktree.remove.failed"));
        break;
      }
    }
    if (ids.length > 0) onRemoved?.(ids);
    setDeleting(false);
    removingRef.current = false;
    if (removed === visibleRows.length) {
      toast.success(t("worktree.remove.success", { count: removed }));
      onClose();
      return;
    }
    if (removed > 0) toast.info(t("worktree.remove.partial", { removed, remaining: visibleRows.length - removed }));
    await checkTargets(activeTargets.current);
  };

  return <Dialog open={open} onOpenChange={next => { if (!next && !deleting) onClose(); }}>
    <DialogContent showCloseButton={false} className="ui-worktree-remove-dialog">
      <div className="ui-worktree-remove-heading">
        <DialogTitle>{t(visibleRows.length > 1 || (checking && targets.length > 1) ? "worktree.remove.titleMultiple" : "worktree.remove.title", { count: visibleRows.length || targets.length })}</DialogTitle>
        <Button size="icon" variant="ghost" disabled={checking || deleting} aria-label={t("worktree.remove.recheck")}
          title={t("worktree.remove.recheck")} onClick={() => { setError(null); void checkTargets(activeTargets.current); }}>
          <RefreshCw size={14} className={checking ? "animate-spin" : undefined} />
        </Button>
      </div>
      <DialogDescription className="ui-worktree-remove-description">{t("worktree.remove.description")}</DialogDescription>
      <div className="ui-worktree-remove-body ui-thin-scroll" aria-busy={checking || deleting}>
        {checking && <p className="ui-worktree-remove-note" role="status">{t("worktree.remove.checking")}</p>}
        {visibleRows.map(({ target, preflight, error: rowError }) => <section className="ui-worktree-remove-target" key={target.worktree.id}>
          <h3>{target.worktree.name}<span>{target.project.name}</span></h3>
          <p className="ui-worktree-remove-path">{preflight?.worktreePath ?? target.worktree.path}</p>
          {target.worktree.origin === "discovered" && <p className="ui-worktree-remove-note">{t("worktree.remove.externalNote")}</p>}
          {rowError && <p className="ui-worktree-remove-error" role="alert">{t(rowError)}</p>}
          {preflight && <>
            <p className="ui-worktree-remove-branch">{preflight.detached ? t("worktree.remove.detached") : preflight.branch}</p>
            {preflight.locked && <p className="ui-worktree-remove-error" role="alert">{t("worktree.remove.locked")}</p>}
            <div className="ui-worktree-remove-check">
              <span>{t(preflight.dirty ? "worktree.remove.changes" : "worktree.remove.clean", { count: totalChanges(preflight) })}</span>
              {preflight.dirty && <small>{t("worktree.remove.changeCounts", { staged: preflight.stagedCount, unstaged: preflight.unstagedCount, untracked: preflight.untrackedCount })}</small>}
            </div>
            {preflight.changedPaths.length > 0 && <ul className="ui-worktree-remove-files" aria-label={t("worktree.remove.changedFiles")}>
              {preflight.changedPaths.slice(0, 8).map(path => <li key={path} title={path}>{path}</li>)}
              {totalChanges(preflight) > 8 && <li>{t("worktree.remove.moreFiles", { count: totalChanges(preflight) - 8 })}</li>}
            </ul>}
            <div className="ui-worktree-remove-check"><span>{t(preflight.runningSessions.length > 0 ? "worktree.remove.runningSessions" : "worktree.remove.noRunningSessions", { count: preflight.runningSessions.length })}</span></div>
            {preflight.runningSessions.length > 0 && <ul className="ui-worktree-remove-session-list">
              {preflight.runningSessions.map(session => <li key={session.sessionId}>{session.title || session.sessionId}</li>)}
            </ul>}
            {preflight.externalProcesses.length > 0 && <div className="ui-worktree-remove-blocked" role="alert">
              <p>{t("worktree.remove.externalProcesses", { count: preflight.externalProcesses.length })}</p>
              <ul>{preflight.externalProcesses.map(process => <li key={process.pid}>{process.name} <span>PID {process.pid}</span></li>)}</ul>
              <p>{t("worktree.remove.externalProcessesAction")}</p>
            </div>}
          </>}
        </section>)}
      </div>
      {!checking && <div className="ui-worktree-remove-choices">
        {dirty && <label><input type="checkbox" checked={discardChanges} disabled={deleting} onChange={event => setDiscardChanges(event.target.checked)} /><span>{t("worktree.remove.discardChanges")}</span></label>}
        {runningCount > 0 && <label><input type="checkbox" checked={closeSessions} disabled={deleting} onChange={event => setCloseSessions(event.target.checked)} /><span>{t("worktree.remove.closeSessions", { count: runningCount })}</span></label>}
        {canDeleteBranch && <div><label><input type="checkbox" checked={deleteBranch} disabled={deleting} onChange={event => setDeleteBranch(event.target.checked)} /><span>{t("worktree.remove.deleteBranch")}</span></label><p className="ui-worktree-remove-choice-note">{t("worktree.remove.deleteBranchNote")}</p></div>}
      </div>}
      {error && <p className="ui-worktree-remove-error" role="alert">{t(error)}</p>}
      <DialogFooter className="ui-worktree-remove-footer">
        <Button variant="outline" disabled={deleting} onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="destructive" disabled={!canConfirm} onClick={() => { void remove(); }}>
          {deleting ? t("worktree.remove.deleting", { current: progress, count: visibleRows.length })
            : t(runningCount > 0 ? "worktree.remove.confirmAndClose" : "worktree.remove.confirm")}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
