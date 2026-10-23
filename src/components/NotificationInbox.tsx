import { useRef, useState } from "react";
import { Bell, Check, CheckCheck, Circle, ExternalLink, RefreshCw, Trash2, X } from "lucide-react";
import { useI18n, getLanguageLocale, type TranslationKey } from "../lib/i18n";
import { resolveNotificationTarget, type InboxEntry } from "../lib/notificationInbox";
import { useNotificationInboxStore } from "../stores/notificationInboxStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useProjectStore } from "../stores/projectStore";
import { useSshHostStore } from "../stores/sshHostStore";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";

const EVENT_KEYS: Record<InboxEntry["event"], TranslationKey> = {
  Notification: "inbox.event.attention", PermissionRequest: "inbox.event.permission",
  Stop: "inbox.event.completed", StopFailure: "inbox.event.failed",
};

export function NotificationInboxButton({ className = "" }: { className?: string }) {
  const { t } = useI18n();
  const count = useNotificationInboxStore(state => state.unreadCount);
  return <button type="button" className={`ui-sidebar-tool ui-focus-ring relative inline-flex !w-auto min-w-[27px] shrink-0 items-center gap-1.5 px-1.5 ${className}`}
    onClick={() => useNotificationInboxStore.getState().open()} title={t("inbox.open", { count })} aria-label={t("inbox.open", { count })}>
    <Bell size={14} className="shrink-0" aria-hidden="true" />
    {count > 0 && <span className="min-w-4 shrink-0 rounded-full bg-[var(--primary)] px-1 text-center text-[10px] leading-4 text-on-primary" aria-hidden="true">{count > 99 ? "99+" : count}</span>}
  </button>;
}

export function NotificationInboxPanel({ onOpenTarget }: { onOpenTarget: (entry: InboxEntry) => Promise<boolean> }) {
  const { t, language } = useI18n();
  const state = useNotificationInboxStore();
  const sessions = useTerminalStore(store => store.sessions);
  const projects = useProjectStore(store => store.projects);
  const worktrees = useProjectStore(store => store.worktrees);
  const hosts = useSshHostStore(store => store.hosts);
  const [opening, setOpening] = useState<string | null>(null);
  const [targetError, setTargetError] = useState<string | null>(null);
  const focusAfterClose = useRef<string | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const date = new Intl.DateTimeFormat(getLanguageLocale(language), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const open = async (entry: InboxEntry) => {
    setOpening(entry.eventId); setTargetError(null);
    try {
      if (await onOpenTarget(entry)) {
        if (await state.setRead(entry, true)) {
          focusAfterClose.current = useTerminalStore.getState().activeSessionId;
          state.close();
        }
      }
      else setTargetError(t("inbox.targetUnavailable"));
    } catch { setTargetError(t("inbox.targetUnavailable")); }
    finally { setOpening(null); }
  };
  return <Dialog open={state.isOpen} onOpenChange={value => { setTargetError(null); if (value) state.open(); else state.close(); }}>
    <DialogContent showCloseButton={false} className="flex max-h-[min(760px,90vh)] w-[min(720px,calc(100vw-24px))] max-w-none flex-col p-0"
      onOpenAutoFocus={() => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
      onCloseAutoFocus={event => {
        const sessionId = focusAfterClose.current;
        focusAfterClose.current = null;
        if (!sessionId) {
          const target = returnFocus.current;
          returnFocus.current = null;
          if (target?.isConnected && target.getClientRects().length > 0) {
            event.preventDefault(); target.focus({ preventScroll: true });
          }
          return;
        }
        returnFocus.current = null;
        event.preventDefault();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (document.querySelector('[role="dialog"][data-state="open"]')) return;
          const terminal = [...document.querySelectorAll<HTMLElement>('[data-terminal-session-id][data-terminal-visible="true"]')]
            .find(element => element.dataset.terminalSessionId === sessionId && element.getClientRects().length > 0);
          (terminal?.querySelector<HTMLElement>(".xterm-helper-textarea") ?? document.getElementById("main-content"))?.focus();
        }));
      }}>
      <div className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
        <div><DialogTitle>{t("inbox.title")}</DialogTitle><DialogDescription className="mt-1 text-xs">{t("inbox.description")}</DialogDescription></div>
        <DialogClose className="ui-sidebar-tool ui-focus-ring shrink-0" aria-label={t("inbox.close")}><X size={16} /></DialogClose>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-2">
        <div className="flex items-center gap-1" role="group" aria-label={t("inbox.filter")}>
          {[false, true].map(unreadOnly => <button key={String(unreadOnly)} type="button" className={`rounded-md px-2.5 py-1.5 text-xs ${state.unreadOnly === unreadOnly ? "bg-[var(--interactive-hover-bg)] font-medium text-on-surface" : "text-on-surface-variant"}`}
            aria-pressed={state.unreadOnly === unreadOnly} onClick={() => state.setUnreadOnly(unreadOnly)}>{unreadOnly ? t("inbox.unread", { count: state.unreadCount }) : t("inbox.all")}</button>)}
        </div>
        <div className="flex items-center gap-1">
          <button type="button" className="ui-sidebar-tool ui-focus-ring" disabled={state.loading} onClick={() => state.showLatest()} title={t("inbox.refresh")} aria-label={t("inbox.refresh")}><RefreshCw size={14} className={state.loading ? "animate-spin" : ""} /></button>
          <button type="button" className="ui-sidebar-tool ui-focus-ring" disabled={!state.unreadCount || state.mutating} onClick={() => void state.markAllRead()} title={t("inbox.markAllRead")} aria-label={t("inbox.markAllRead")}><CheckCheck size={15} /></button>
          <button type="button" className="ui-sidebar-tool ui-focus-ring" disabled={state.mutating} onClick={() => void state.clearRead()} title={t("inbox.clearRead")} aria-label={t("inbox.clearRead")}><Trash2 size={14} /></button>
        </div>
      </div>
      {(state.error || targetError) && <div role="alert" className="border-b border-[var(--border)] px-5 py-3 text-sm text-[var(--warning)]">{targetError ?? t("inbox.loadError")} {state.error && <button className="underline" onClick={() => void state.refresh()}>{t("inbox.retry")}</button>}</div>}
      {state.persistenceError && <div role="alert" className="border-b border-[var(--border)] px-5 py-3 text-sm text-[var(--warning)]">{t("inbox.persistenceError")}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-busy={state.loading}>
        {!state.entries.length && <div className="px-5 py-14 text-center text-sm text-on-surface-variant">{state.loading ? t("inbox.loading") : t(state.unreadOnly ? "inbox.emptyUnread" : "inbox.empty")}</div>}
        <ul className="m-0 list-none p-0">
          {state.entries.map(entry => {
            const session = resolveNotificationTarget(entry, sessions);
            const project = projects.find(item => item.id === (session?.projectId ?? entry.projectId));
            const worktree = session?.worktreeId ? worktrees.find(item => item.id === session.worktreeId) : undefined;
            const host = entry.hostId ? hosts.find(item => item.id === entry.hostId) : undefined;
            const name = session?.title || project?.name || entry.cwd?.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || t("inbox.unknownTarget");
            const location = [project?.name, worktree?.branch, entry.environment === "ssh" ? host?.name || "SSH" : entry.environment === "wsl" ? `WSL${entry.wslDistro ? ` · ${entry.wslDistro}` : ""}` : null].filter(Boolean).join(" · ");
            const isQuestion = entry.event === "Notification" && ["AskUserQuestion", "request_user_input"].includes(entry.toolName ?? "");
            const eventLabel = t(isQuestion ? "inbox.event.question" : EVENT_KEYS[entry.event]);
            return <li key={entry.eventId} className={`flex items-start gap-3 border-b border-[var(--border)] px-5 py-3.5 ${entry.readAt === null ? "bg-[var(--interactive-hover-bg)]" : ""}`}>
              <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${entry.readAt === null ? "bg-[var(--primary)]" : "bg-transparent"}`} aria-label={t(entry.readAt === null ? "inbox.unreadItem" : "inbox.readItem")} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"><span className="text-sm font-medium text-on-surface">{eventLabel}</span><time className="shrink-0 text-[11px] tabular-nums text-on-surface-variant" dateTime={new Date(entry.receivedAt).toISOString()}>{date.format(entry.receivedAt)}</time></div>
                <p className="mt-1 truncate text-xs text-on-surface-variant" title={entry.cwd ?? undefined}>{entry.source} · {name}</p>
                {location && <p className="mt-0.5 truncate text-[11px] text-on-surface-variant">{location}</p>}
                {entry.title && entry.title !== entry.message && <p className="mt-2 line-clamp-2 break-words text-xs font-medium text-on-surface">{entry.title}</p>}
                {entry.message && <p className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-xs leading-relaxed text-on-surface">{entry.message}</p>}
                <div className="mt-2 flex flex-wrap gap-3">
                  <button type="button" disabled={opening !== null} onClick={() => void open(entry)} className="ui-focus-ring inline-flex items-center gap-1 rounded text-xs text-[var(--primary)]"><ExternalLink size={12} />{t("inbox.openTarget")}</button>
                  <button type="button" disabled={state.mutating} onClick={() => void state.setRead(entry, entry.readAt === null)} className="ui-focus-ring inline-flex items-center gap-1 rounded text-xs text-on-surface-variant">{entry.readAt === null ? <Check size={12} /> : <Circle size={11} />}{t(entry.readAt === null ? "inbox.markRead" : "inbox.markUnread")}</button>
                </div>
              </div>
            </li>;
          })}
        </ul>
        {(state.nextBefore !== null || state.pageHistory.length > 0) && <div className="flex justify-center gap-3 p-3">
          {state.pageHistory.length > 0 && <button type="button" className="ui-focus-ring rounded px-3 py-1.5 text-xs text-[var(--primary)]" disabled={state.loading} onClick={() => state.previousPage()}>{t("inbox.newer")}</button>}
          {state.nextBefore !== null && <button type="button" className="ui-focus-ring rounded px-3 py-1.5 text-xs text-[var(--primary)]" disabled={state.loading} onClick={() => void state.loadMore()}>{t("inbox.loadMore")}</button>}
        </div>}
      </div>
      <div className="border-t border-[var(--border)] px-5 py-2.5 text-[11px] leading-relaxed text-on-surface-variant">
        {t("inbox.retention")}{state.trimmedCount > 0 && <span> {t("inbox.trimmed", { count: state.trimmedCount })}</span>}
      </div>
    </DialogContent>
  </Dialog>;
}
