import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw, Search } from "lucide-react";
import { useI18n, type TranslationKey } from "../../lib/i18n";
import type { ReplayEventScope } from "../../lib/replayScope";
import { useReplayEvents } from "../../hooks/useReplayEvents";
import { readReplaySessions, type ReplayEvent, type ReplayEventKind, type ReplaySession } from "../../stores/replayStore";
import "../../styles/session-records.css";

const KINDS: ReplayEventKind[] = ["prompt", "tool", "mcp", "skill", "subtask", "snapshot", "error", "permission", "notification", "session"];

export function formatRecordTime(timestamp: string, language: string) {
  return new Date(timestamp).toLocaleString(language, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function EventRow({ event }: { event: ReplayEvent }) {
  const { t, language } = useI18n();
  const [expanded, setExpanded] = useState(false);
  return <article className="session-event" data-status={event.status}>
    <button type="button" className="session-event-toggle ui-focus-ring" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      <span className="session-event-body">
        <span className="session-event-meta"><span>{t(`aiReplay.kind.${event.kind}` as TranslationKey)}</span><time>{formatRecordTime(event.timestamp, language)}</time></span>
        <span className="session-event-title">{event.title}</span>
        {event.detail && <span className="session-event-summary">{event.detail}</span>}
        <span className="session-event-status">{t(`aiReplay.status.${event.status}` as TranslationKey)}{event.durationMs != null && ` · ${event.durationMs} ms`}</span>
      </span>
    </button>
    {expanded && <div className="session-event-content">
      {event.tags.length > 0 && <div className="session-record-note">{event.tags.join(" · ")}</div>}
      <pre>{JSON.stringify(event.payload, null, 2)}</pre>
    </div>}
  </article>;
}

export function SessionEventLog({ scope }: { scope: ReplayEventScope | null }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [limit, setLimit] = useState(100);
  const [archive, setArchive] = useState(false);
  const [archiveKey, setArchiveKey] = useState("");
  const [archiveLimit, setArchiveLimit] = useState(100);
  const [sessions, setSessions] = useState<ReplaySession[]>([]);
  const [archiveError, setArchiveError] = useState("");
  const selectedScope: ReplayEventScope | null = archive
    ? archiveKey ? { kind: "terminal", sessionKey: archiveKey } : null
    : scope;
  const { events, hasMore, loading, error, refresh } = useReplayEvents(selectedScope, { kind, query, limit });
  const scopeKey = JSON.stringify(scope);
  useEffect(() => { setArchive(false); setArchiveKey(""); setLimit(100); }, [scopeKey]);
  useEffect(() => { setLimit(100); }, [query, kind, archiveKey]);
  useEffect(() => {
    if (!archive) return;
    let cancelled = false;
    setArchiveError("");
    void readReplaySessions(archiveLimit).then((items) => {
      if (cancelled) return;
      setSessions(items);
      setArchiveKey((key) => key || items[0]?.sessionKey || "");
    }, (err) => { if (!cancelled) setArchiveError(String(err)); });
    return () => { cancelled = true; };
  }, [archive, archiveLimit]);

  return <section className="session-records" aria-label={t("sessionEvents.title")}>
    <div className="session-record-toolbar">
      <span className="session-record-note">{t("sessionEvents.description")}</span>
      <button type="button" className="ui-focus-ring" aria-label={t("common.refresh")} onClick={refresh}><RefreshCw size={13} /></button>
    </div>
    <div className="session-record-toolbar">
      <button type="button" className="ui-focus-ring" aria-pressed={archive} onClick={() => setArchive(!archive)}>{t(archive ? "sessionEvents.current" : "sessionEvents.archive")}</button>
      <span className="session-record-note">{t("sessionEvents.count", { count: events.length })}</span>
    </div>
    {archive && <>
      <select className="session-record-select" aria-label={t("sessionEvents.archive")} value={archiveKey} onChange={(event) => setArchiveKey(event.target.value)}>
        {sessions.map((session) => <option key={session.sessionKey} value={session.sessionKey}>{session.title} · {session.source} · {session.projectPath || session.cliSessionId || session.sessionKey}</option>)}
      </select>
      {sessions.length >= archiveLimit && <button type="button" onClick={() => setArchiveLimit((value) => value + 100)}>{t("sessionEvents.loadMore")}</button>}
    </>}
    <div className="session-record-filters">
      <label><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("aiReplay.search")} aria-label={t("aiReplay.search")} /></label>
      <select aria-label={t("aiReplay.progress.logFilter")} value={kind} onChange={(event) => setKind(event.target.value)}>
        <option value="all">{t("aiReplay.filter.all")}</option>
        {KINDS.map((value) => <option key={value} value={value}>{t(`aiReplay.kind.${value}` as TranslationKey)}</option>)}
      </select>
    </div>
    {(error || archiveError) && <p className="session-record-error" role="alert">{t("sessionEvents.error")}<br />{error || archiveError}</p>}
    {loading && events.length === 0 ? <p className="session-record-note">{t("common.loading")}</p> : !error && events.length === 0 && <p className="session-record-note">{t(query || kind !== "all" ? "aiReplay.progress.emptyLog" : "sessionEvents.empty")}</p>}
    <div>{events.map((event) => <EventRow key={`${event.sessionKey}:${event.eventIndex}`} event={event} />)}</div>
    {hasMore && <button type="button" className="session-record-more ui-focus-ring" disabled={loading} onClick={() => setLimit((value) => value + 100)}>{t("sessionEvents.loadMore")}</button>}
  </section>;
}
