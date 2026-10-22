import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Camera, Code2, GitFork, RefreshCw, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { useI18n } from "../../lib/i18n";
import { normalizeReplayProjectPath } from "../../lib/replayScope";
import { useReplayEvents } from "../../hooks/useReplayEvents";
import { readReplayEvents, readReplaySnapshot, useReplayStore, type ReplayEvent } from "../../stores/replayStore";
import { ConfirmDialog } from "../ConfirmDialog";
import { DiffModal } from "../history/DiffModal";
import { formatRecordTime } from "../history/SessionEventLog";
import "../../styles/session-records.css";

type PendingAction = { kind: "rollback" | "fork"; sessionKey: string; projectPath: string; targetPatch: string; expectedCurrentPatch: string; targetHead: string; branchName: string };

export function GitSnapshotPanel({ projectPath, remote, onChanged }: { projectPath: string | null; remote: boolean; onChanged: () => void }) {
  const { t, language } = useI18n();
  const [limit, setLimit] = useState(30);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [diff, setDiff] = useState<ReplayEvent | null>(null);
  const scope = projectPath && !remote ? { kind: "snapshots" as const, projectPath } : null;
  const { events, hasMore, loading, error, refresh } = useReplayEvents(scope, { limit });

  const prepare = async (event: ReplayEvent, kind: "view" | "rollback" | "fork") => {
    if (!scope || busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try {
      const target = await readReplaySnapshot(event);
      const patch = target.payload.patch;
      if (typeof patch !== "string" || !patch) throw new Error(t("git.snapshots.missingPatch"));
      if (kind === "view") { setDiff(target); return; }
      // Read the newest snapshot for this worktree, regardless of which session saved it.
      const latestPage = await readReplayEvents(scope, { limit: 1 });
      const latest = latestPage.events[0] ? await readReplaySnapshot(latestPage.events[0]) : null;
      const expectedCurrentPatch = latest?.payload.patch;
      const targetHead = target.payload.head;
      const storedPath = target.payload.projectPath;
      if (typeof expectedCurrentPatch !== "string" || typeof targetHead !== "string" || !targetHead || typeof storedPath !== "string" || normalizeReplayProjectPath(storedPath) !== normalizeReplayProjectPath(scope.projectPath)) {
        throw new Error(t("git.snapshots.missingPatch"));
      }
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
      setPending({ kind, sessionKey: event.sessionKey, projectPath: storedPath, targetPatch: patch, expectedCurrentPatch, targetHead, branchName: `replay/${stamp}-event-${event.eventIndex}` });
    } catch (err) {
      toast.error(t("git.snapshots.actionFailed"), { description: String(err) });
    } finally { busyRef.current = false; setBusy(false); }
  };

  const confirm = async () => {
    if (!pending || busyRef.current) return;
    const action = pending;
    setPending(null); busyRef.current = true; setBusy(true);
    try {
      await invoke(action.kind === "rollback" ? "git_restore_worktree_snapshot" : "git_fork_worktree_snapshot", {
        projectPath: action.projectPath, targetPatch: action.targetPatch,
        expectedCurrentPatch: action.expectedCurrentPatch, targetHead: action.targetHead,
        ...(action.kind === "fork" ? { branchName: action.branchName } : {}),
      });
      toast.success(t(action.kind === "rollback" ? "aiReplay.rollback.success" : "aiReplay.fork.success"));
      await useReplayStore.getState().captureCodeSnapshot(action.sessionKey, action.projectPath, action.kind);
      refresh(); onChanged();
    } catch (err) {
      toast.error(t(action.kind === "rollback" ? "aiReplay.rollback.failed" : "aiReplay.fork.failed"), { description: String(err) });
    } finally { busyRef.current = false; setBusy(false); }
  };

  return <section className="session-records" aria-label={t("git.snapshots.title")}>
    <div className="session-record-toolbar"><span className="session-record-note">{t("git.snapshots.description")}</span><button type="button" aria-label={t("common.refresh")} onClick={refresh}><RefreshCw size={13} /></button></div>
    {remote ? <p className="session-record-note">{t("git.snapshots.remote")}</p> : <>
      {error && <p className="session-record-error" role="alert">{t("sessionEvents.error")}<br />{error}</p>}
      {loading && !events.length ? <p className="session-record-note">{t("common.loading")}</p> : !error && !events.length && <p className="session-record-note">{t("git.snapshots.empty")}</p>}
      {events.map((event) => <article key={`${event.sessionKey}:${event.eventIndex}`} className="git-snapshot">
        <div className="session-event-meta"><Camera size={13} /><time>{formatRecordTime(event.timestamp, language)}</time><span>{String(event.payload.branch ?? "")}</span></div>
        <div className="session-event-title">{Array.isArray(event.payload.changedFiles) ? t("aiReplay.snapshot.detail", { branch: String(event.payload.branch ?? "").trim() || String(event.payload.head ?? "").slice(0, 8), count: event.payload.changedFiles.length }) : event.detail || event.title}</div>
        <div className="session-record-note" title={event.sessionKey}>{t("git.snapshots.session", { id: event.sessionKey.slice(0, 12) })} · {String(event.payload.head ?? "").slice(0, 8)}</div>
        {Array.isArray(event.payload.changedFiles) && <details className="git-snapshot-files"><summary>{t("git.snapshots.files", { count: event.payload.changedFiles.length })}</summary>{event.payload.changedFiles.map((file, index) => <div key={index}>{String(file)}</div>)}</details>}
        <div className="git-snapshot-actions">
          <button type="button" disabled={busy} onClick={() => void prepare(event, "view")}><Code2 size={13} />{t("aiReplay.action.viewSnapshot")}</button>
          <button type="button" disabled={busy} onClick={() => void prepare(event, "rollback")}><RotateCcw size={13} />{t("aiReplay.action.rollback")}</button>
          <button type="button" disabled={busy} onClick={() => void prepare(event, "fork")}><GitFork size={13} />{t("aiReplay.action.fork")}</button>
        </div>
      </article>)}
      {hasMore && <button className="session-record-more" type="button" disabled={loading} onClick={() => setLimit((value) => value + 30)}>{t("sessionEvents.loadMore")}</button>}
    </>}
    <DiffModal open={Boolean(diff)} messages={diff ? [{ role: "assistant", content: String(diff.payload.patch), timestamp: diff.timestamp }] : undefined} onClose={() => setDiff(null)} />
    <ConfirmDialog open={Boolean(pending)} title={t(pending?.kind === "fork" ? "aiReplay.action.fork" : "aiReplay.action.rollback")} message={pending?.kind === "fork" ? t("aiReplay.fork.confirm", { branch: pending.branchName }) : t("aiReplay.rollback.confirm")} confirmText={t("common.confirm")} cancelText={t("common.cancel")} danger={pending?.kind === "rollback"} onClose={() => setPending(null)} onConfirm={() => void confirm()} />
  </section>;
}
