import { useI18n } from "../../lib/i18n";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";

export interface ContinuationTarget { id: string; name: string; path: string; current: boolean; }

/** The picker does not launch processes; the store owns validation and the stop/resume transaction. */
export function WorktreeContinuationPicker({ open, sourceTitle, sourcePath, conversationId, targets, selectedId,
  pending, loading, error, blocked, claude = false, onSelect, onContinue, onClose }: {
  open: boolean;
  sourceTitle: string;
  sourcePath: string;
  conversationId: string;
  targets: ContinuationTarget[];
  selectedId: string | null;
  pending: boolean;
  loading: boolean;
  error?: string;
  blocked: boolean;
  claude?: boolean;
  onSelect: (id: string) => void;
  onContinue: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const validTarget = targets.some(target => target.id === selectedId && !target.current);
  return <Dialog open={open} onOpenChange={value => { if (!value && !pending) onClose(); }}>
    <DialogContent className="flex max-h-[85dvh] w-[calc(100%-2rem)] max-w-xl flex-col overflow-hidden" showCloseButton={false}
      onInteractOutside={event => { if (pending) event.preventDefault(); }}
      onEscapeKeyDown={event => { if (pending) event.preventDefault(); }}>
      <div className="min-h-0 overflow-y-auto">
        <DialogTitle>{t("worktree.continue.title")}</DialogTitle>
        <DialogDescription className="mt-2">{t("worktree.continue.description")}</DialogDescription>
        {claude && <p className="mt-2 text-xs text-text-muted">{t("worktree.continue.claudeDirectory")}</p>}
        <div className="mt-4 border-y border-border py-3 text-sm">
          <div className="font-medium break-words">{sourceTitle}</div>
          <div className="mt-1 text-xs text-text-muted break-all">{t("worktree.continue.source")}: {sourcePath || "—"}</div>
          <div className="mt-1 text-xs text-text-muted break-all">{t("worktree.continue.identity")}: <code>{conversationId || "—"}</code></div>
        </div>
        <fieldset className="mt-4" disabled={pending || loading || blocked}>
          <legend className="mb-2 text-xs text-text-muted">{t("worktree.continue.target")}</legend>
          <div className="space-y-1">
            {targets.map(target => <label key={target.id} className={`flex items-start gap-3 rounded-md px-2 py-2.5 ${target.current ? "opacity-50" : "cursor-pointer hover:bg-bg-tertiary"}`}>
              <input type="radio" name="continuation-worktree" value={target.id} disabled={target.current}
                checked={selectedId === target.id} onChange={() => onSelect(target.id)} className="mt-1 accent-[var(--color-accent)]" />
              <span className="min-w-0 text-sm">
                <span className="break-words">{target.name}</span>
                {target.current && <span className="ml-2 text-xs text-text-muted">{t("worktree.continue.current")}</span>}
                <span className="mt-0.5 block break-all text-xs text-text-muted">{target.path}</span>
              </span>
            </label>)}
          </div>
        </fieldset>
        {loading && <p role="status" className="mt-3 text-xs text-text-muted">{t("common.loading")}</p>}
        {!loading && !error && !targets.some(target => !target.current) && <p className="mt-3 text-sm text-text-muted">{t("worktree.continue.noTargets")}</p>}
        {error && <p role="alert" className="mt-3 text-sm text-red-400 break-words whitespace-pre-wrap">{error}</p>}
      </div>
      <DialogFooter className="shrink-0">
        <Button onClick={onClose} disabled={pending}>{t("common.cancel")}</Button>
        <Button variant="default" disabled={pending || loading || blocked || !validTarget} onClick={onContinue}>
          {t(pending ? "worktree.continue.pending" : "worktree.continue.confirm")}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
