import { useEffect, useState } from "react";
import { useI18n } from "../../lib/i18n";
import { WorktreeContinuationError, worktreeConversationIdentity } from "../../lib/worktreeConversation";
import { useProjectStore } from "../../stores/projectStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useWorktreeContinuationStore } from "../../stores/worktreeContinuationStore";
import { WorktreeContinuationPicker, type ContinuationTarget } from "./WorktreeContinuationPicker";

export function WorktreeContinuationDialog({ onContinued }: { onContinued: () => void }) {
  const { t } = useI18n();
  const intent = useWorktreeContinuationStore(state => state.intent);
  const pending = useWorktreeContinuationStore(state => state.pending);
  const source = useTerminalStore(state => state.sessions.find(session => session.id === intent?.sourceId));
  const projects = useProjectStore(state => state.projects);
  const worktrees = useProjectStore(state => state.worktrees);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>();
  const project = projects.find(project => project.id === (source?.workspace?.projectId ?? source?.projectId));
  const sourceWorktreeId = source?.workspace?.worktreeId ?? source?.worktreeId;
  const identity = source ? worktreeConversationIdentity(source, project) : undefined;
  const issue = !source ? "sourceChanged" : !project || source.workspace === null ? "unbound"
    : identity?.issue ?? (identity?.sessionId !== intent?.conversationId ? "sourceChanged" : undefined);

  useEffect(() => {
    setLoading(false);
    if (!intent) return;
    setSelectedId(null);
    setError(undefined);
    // One refresh on opening; no new background polling or directory scanning.
    if (!project || project.environment_type === "ssh") return;
    let disposed = false;
    setLoading(true);
    useProjectStore.getState().refreshWorktrees()
      .catch(error => { if (!disposed) setError(error); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [intent, project?.id, project?.environment_type]);

  const targets: ContinuationTarget[] = project ? [
    { id: `main:${project.id}`, name: t("workspace.primaryName"), path: project.path, current: !sourceWorktreeId },
    ...worktrees.filter(tree => tree.project_id === project.id && tree.status === "active")
      .map(tree => ({ id: tree.id, name: tree.branch || tree.name, path: tree.path, current: tree.id === sourceWorktreeId })),
  ] : [];
  const errorMessage = issue ? t(`worktree.continue.error.${issue}`)
    : error instanceof WorktreeContinuationError ? t(`worktree.continue.error.${error.issue}`)
    : error ? `${t("worktree.continue.failed")}\n${error instanceof Error ? error.message : String(error)}` : undefined;

  return <WorktreeContinuationPicker open={!!intent} sourceTitle={source?.title ?? ""}
    sourcePath={source?.workspace?.path ?? worktrees.find(tree => tree.id === sourceWorktreeId)?.path ?? project?.path ?? ""}
    conversationId={intent?.conversationId ?? ""} targets={targets} selectedId={selectedId}
    pending={pending} loading={loading} error={errorMessage} blocked={!!issue} claude={identity?.tool === "claude"}
    onSelect={id => { setSelectedId(id); setError(undefined); }}
    onClose={() => useWorktreeContinuationStore.getState().dismiss()}
    onContinue={() => {
      if (!selectedId || !project) return;
      setError(undefined);
      void useWorktreeContinuationStore.getState().continueIn(selectedId === `main:${project.id}` ? null : selectedId)
        .then(onContinued).catch(setError);
    }} />;
}
