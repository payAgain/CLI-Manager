import { useCallback, useEffect, useState } from "react";
import type { ReplayEventQuery, ReplayEventScope } from "../lib/replayScope";
import { readReplayEvents, useReplayStore, type ReplayEvent } from "../stores/replayStore";

/** Reads on demand; Hook recording continues independently while the view/window is hidden. */
export function useReplayEvents(scope: ReplayEventScope | null, options: ReplayEventQuery = {}) {
  const scopeKey = JSON.stringify(scope);
  const optionsKey = JSON.stringify(options);
  const [revision, setRevision] = useState(0);
  const [visible, setVisible] = useState(document.visibilityState !== "hidden");
  const [result, setResult] = useState({ key: "", events: [] as ReplayEvent[], hasMore: false, loading: true, error: "" });
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const visibility = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);
  useEffect(() => {
    if (!visible || !scope) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = useReplayStore.subscribe((state, previous) => {
      if (state.eventsBySession === previous.eventsBySession || timer) return;
      timer = setTimeout(() => { timer = undefined; refresh(); }, 300);
    });
    return () => { unsubscribe(); clearTimeout(timer); };
  }, [visible, scopeKey, refresh]);
  const key = `${scopeKey}:${optionsKey}`;
  useEffect(() => {
    if (!visible || !scope) return;
    let cancelled = false;
    setResult((previous) => ({ ...previous, loading: true, error: "" }));
    void readReplayEvents(JSON.parse(scopeKey), JSON.parse(optionsKey)).then(
      (data) => { if (!cancelled) setResult({ key, ...data, loading: false, error: "" }); },
      (error) => { if (!cancelled) setResult({ key, events: [], hasMore: false, loading: false, error: String(error) }); },
    );
    return () => { cancelled = true; };
  }, [scopeKey, optionsKey, key, visible, revision]);
  return {
    ...(result.key === key ? result : { events: [], hasMore: false, loading: Boolean(scope), error: "" }),
    refresh,
  };
}
