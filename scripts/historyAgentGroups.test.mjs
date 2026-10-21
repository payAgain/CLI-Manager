import test from "node:test";
import assert from "node:assert/strict";
import { groupHistorySessionsByAgent } from "../src/lib/historyAgentGroups.ts";

test("sessions from different dates stay together under their Agent, newest Agent first", () => {
  const sessions = [
    { sessionKey: "pi:today", source: "pi", updated_at: 300 },
    { sessionKey: "codex:today", source: "codex", updated_at: 200 },
    { sessionKey: "pi:last-week", source: "pi", updated_at: 100 },
  ];
  const before = structuredClone(sessions);
  const groups = groupHistorySessionsByAgent(sessions);
  assert.deepEqual(groups.map(group => group.source), ["pi", "codex"]);
  assert.deepEqual(groups[0].items.map(item => item.sessionKey), ["pi:today", "pi:last-week"]);
  assert.deepEqual(sessions, before);
});

test("Agent identity does not merge same-title or same-directory sessions from different sources", () => {
  const sessions = [" Pi ", "codex", "pi", "future-agent", ""].map((source, index) => ({
    sessionKey: `session:${index}`, source, displayTitle: "same title", cwd: "/same/path",
  }));
  const groups = groupHistorySessionsByAgent(sessions);
  assert.deepEqual(groups.map(group => [group.source, group.items.length]), [["pi", 2], ["codex", 1], ["future-agent", 1], ["", 1]]);
  assert.equal(new Set(groups.flatMap(group => group.items.map(item => item.sessionKey))).size, sessions.length);
});

test("refresh and pagination retain each Agent's existing session order without modifying records", () => {
  const loaded = Array.from({ length: 2000 }, (_, index) => ({ sessionKey: `session:${index}`, source: index % 2 ? "pi" : "codex" }));
  const firstPage = groupHistorySessionsByAgent(loaded.slice(0, 20));
  const nextPage = groupHistorySessionsByAgent(loaded);
  for (const group of firstPage) {
    assert.deepEqual(nextPage.find(next => next.source === group.source).items.slice(0, 10), group.items);
  }
  assert.equal(nextPage.flatMap(group => group.items).length, loaded.length);
  assert.deepEqual(groupHistorySessionsByAgent([]), []);
});
