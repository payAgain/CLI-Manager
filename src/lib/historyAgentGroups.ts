import type { HistorySessionView } from "./types";

export interface HistoryAgentGroup {
  source: string;
  items: HistorySessionView[];
}

/** Keep the newest Agent first and retain each Agent's session order. */
export function groupHistorySessionsByAgent(sessions: HistorySessionView[]): HistoryAgentGroup[] {
  const groups = new Map<string, HistoryAgentGroup>();
  for (const session of sessions) {
    const source = session.source.trim().toLowerCase();
    let group = groups.get(source);
    if (!group) {
      group = { source, items: [] };
      groups.set(source, group);
    }
    group.items.push(session);
  }
  return [...groups.values()];
}
