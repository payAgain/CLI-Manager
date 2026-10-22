import type { HistorySessionView } from "./types";

/**
 * 从会话文件路径推断 subagent 转录的父会话 ID；非 subagent 转录返回 null。
 * 判定需与后端 is_subagent_transcript_path 保持一致：subagents/ 目录下的 agent-*.jsonl。
 */
export function inferClaudeSubagentParentSessionId(session: Pick<HistorySessionView, "file_path" | "session_id">): string | null {
  const parts = (session.file_path ?? "").replace(/\\/g, "/").split("/").filter(Boolean);
  const subagentsIndex = parts.findIndex((part) => part.toLowerCase() === "subagents");
  if (subagentsIndex <= 0) return null;

  const fileName = parts[subagentsIndex + 1] ?? "";
  if (!/^agent-[^/]+\.jsonl$/i.test(fileName)) return null;

  const parentSessionId = parts[subagentsIndex - 1] ?? "";
  if (!parentSessionId || parentSessionId === session.session_id) return null;
  return parentSessionId;
}

export function inferSubagentParentSessionId(session: HistorySessionView): string | null {
  const parent = session.subagent?.parent_session_id?.trim();
  if (parent && parent !== session.session_id) return parent;
  return session.source === "claude" ? inferClaudeSubagentParentSessionId(session) : null;
}

function relationKey(session: HistorySessionView, sessionId: string): string {
  const source = session.source.trim().toLowerCase();
  const ref = session.session_ref;
  if (ref?.transportKind === "ssh") return JSON.stringify([source, "ssh", ref.sourceInstanceId, sessionId]);
  let path = session.file_path.replace(/\\/g, "/").replace(/^\/\/\?\/UNC\//i, "//").replace(/^\/\/\?\//, "");
  path = path.replace(/^\/\/wsl\$\//i, "//wsl.localhost/");
  if (path.startsWith("//") || /^[a-z]:/i.test(path)) path = path.toLowerCase();
  const marker = source === "codex" ? "/sessions/" : "/subagents/";
  const index = path.toLowerCase().lastIndexOf(marker);
  const base = index < 0 ? path.slice(0, path.lastIndexOf("/"))
    : source === "codex" ? path.slice(0, index) : path.slice(0, index).replace(/\/[^/]+$/, "");
  return JSON.stringify([source, "local", base, sessionId]);
}

export function buildHistorySessionHierarchy(items: HistorySessionView[]) {
  const byId = new Map(items.map((item) => [relationKey(item, item.session_id), item]));
  const byKey = new Map(items.map((item) => [item.sessionKey, item]));
  const parentByChildKey = new Map<string, HistorySessionView>();
  for (const item of items) {
    const parentId = inferSubagentParentSessionId(item);
    const parent = parentId ? byId.get(relationKey(item, parentId)) : undefined;
    if (parent && parent.sessionKey !== item.sessionKey) parentByChildKey.set(item.sessionKey, parent);
  }
  // Corrupt/cyclic metadata must never hide a whole family or recurse forever.
  const done = new Set<string>();
  for (const item of items) {
    const path = new Set<string>();
    let key = item.sessionKey;
    while (!done.has(key)) {
      if (path.has(key)) { parentByChildKey.delete(key); break; }
      path.add(key);
      const parent = parentByChildKey.get(key);
      if (!parent) break;
      key = parent.sessionKey;
    }
    for (const visited of path) done.add(visited);
  }
  const childrenByParentKey = new Map<string, HistorySessionView[]>();
  for (const item of items) {
    const parent = parentByChildKey.get(item.sessionKey);
    if (!parent) continue;
    const children = childrenByParentKey.get(parent.sessionKey) ?? [];
    children.push(item);
    childrenByParentKey.set(parent.sessionKey, children);
  }
  const rootKeys = new Map<string, string>();
  const roots = new Map<string, HistorySessionView>();
  for (const item of items) {
    const trail: string[] = [];
    let key = item.sessionKey;
    while (!rootKeys.has(key) && parentByChildKey.has(key)) {
      trail.push(key);
      key = parentByChildKey.get(key)!.sessionKey;
    }
    key = rootKeys.get(key) ?? key;
    rootKeys.set(item.sessionKey, key);
    for (const childKey of trail) rootKeys.set(childKey, key);
    roots.set(key, byKey.get(key)!);
  }
  return { roots: [...roots.values()], childrenByParentKey, parentByChildKey };
}

export function buildHistorySessionChildMap(items: HistorySessionView[]) {
  return buildHistorySessionHierarchy(items).childrenByParentKey;
}

/** Retain only matching sessions and the ancestors needed to show their ownership. */
export function includeHistorySessionAncestors(items: HistorySessionView[], allItems: HistorySessionView[]) {
  const { parentByChildKey } = buildHistorySessionHierarchy(allItems);
  const result = new Map(items.map((item) => [item.sessionKey, item]));
  for (const item of items) {
    let parent = parentByChildKey.get(item.sessionKey);
    while (parent && !result.has(parent.sessionKey)) {
      result.set(parent.sessionKey, parent);
      parent = parentByChildKey.get(parent.sessionKey);
    }
  }
  return [...result.values()];
}

interface HistorySessionTreePosition {
  familyKey: string;
  familyStart: boolean;
  familyEnd: boolean;
  familyExpanded: boolean;
  /** One continuation flag per ancestor column, including this row's own branch. */
  branches: boolean[];
}

export type HistorySessionTreeRow = HistorySessionTreePosition & (
  | { type: "session"; id: string; item: HistorySessionView; depth: number; childCount: number; parentSessionId: string | null }
  | { type: "missingParent"; id: string; parentSessionId: string }
);

export function buildHistorySessionTreeRows(items: HistorySessionView[], expandedParentKeys: Set<string>): HistorySessionTreeRow[] {
  const { roots, childrenByParentKey } = buildHistorySessionHierarchy(items);
  const rows: HistorySessionTreeRow[] = [];
  const families = new Map<string, HistorySessionView[]>();
  for (const root of roots) {
    const parentId = inferSubagentParentSessionId(root);
    const key = parentId ? `missing:${relationKey(root, parentId)}` : `root:${root.sessionKey}`;
    const family = families.get(key) ?? [];
    family.push(root);
    families.set(key, family);
  }
  for (const [key, family] of families) {
    const familyStart = rows.length;
    const position = { familyKey: key, familyStart: false, familyEnd: false, familyExpanded: false };
    const missingParentId = inferSubagentParentSessionId(family[0]);
    if (missingParentId) rows.push({ type: "missingParent", id: key, parentSessionId: missingParentId, ...position, branches: [] });
    for (const [rootIndex, root] of family.entries()) {
      const stack = [{ item: root, depth: missingParentId ? 1 : 0,
        branches: missingParentId ? [rootIndex < family.length - 1] : [] }];
      while (stack.length) {
        const { item, depth, branches } = stack.pop()!;
        const children = childrenByParentKey.get(item.sessionKey) ?? [];
        rows.push({ type: "session", id: `session:${item.sessionKey}`, item, depth, childCount: children.length,
          parentSessionId: inferSubagentParentSessionId(item), ...position, branches });
        if (expandedParentKeys.has(item.sessionKey)) {
          for (let index = children.length - 1; index >= 0; index -= 1) {
            stack.push({ item: children[index], depth: depth + 1, branches: [...branches, index < children.length - 1] });
          }
        }
      }
    }
    rows[familyStart].familyStart = true;
    rows[rows.length - 1].familyEnd = true;
    for (let index = familyStart; index < rows.length; index += 1) rows[index].familyExpanded = rows.length - familyStart > 1;
  }
  return rows;
}
