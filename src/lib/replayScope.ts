/** Read scopes for the existing replay tables. A terminal ID is not a CLI session ID. */
export type ReplayEventScope =
  | { kind: "terminal"; sessionKey: string }
  | { kind: "history"; cliSessionId: string; source: string; remote: boolean; remoteHostId?: string | null }
  | { kind: "snapshots"; projectPath: string };

export interface ReplayEventQuery {
  limit?: number;
  kind?: string;
  query?: string;
}

export function normalizeReplayProjectPath(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/^\/\/wsl\$\//i, "//wsl.localhost/").replace(/\/+$/, "");
  // Linux/WSL paths remain case-sensitive, including the path after the distro name.
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function buildReplayEventQuery(scope: ReplayEventScope, options: ReplayEventQuery = {}) {
  const values: Array<string | number> = [];
  const bind = (value: string | number) => { values.push(value); return `$${values.length}`; };
  const payload = "CASE WHEN json_valid(e.payload_json) THEN e.payload_json ELSE '{}' END";
  const field = (key: string) => `json_extract(${payload}, '$.${key}')`;
  const conditions: string[] = [];
  if (scope.kind === "terminal") {
    conditions.push(`e.session_key = ${bind(scope.sessionKey)}`);
  } else if (scope.kind === "history") {
    // Prefer the identity stored on each event: a terminal can run several CLI sessions.
    conditions.push(`COALESCE(NULLIF(${field("sessionId")}, ''), s.cli_session_id) = ${bind(scope.cliSessionId)}`);
    conditions.push(`COALESCE(NULLIF(${field("source")}, ''), s.source) = ${bind(scope.source)}`);
    if (scope.remote) {
      conditions.push(`${field("environmentType")} = 'ssh'`);
      conditions.push(scope.remoteHostId ? `${field("remoteHostId")} = ${bind(scope.remoteHostId)}` : "0 = 1");
    } else {
      conditions.push(`COALESCE(${field("environmentType")}, '') <> 'ssh'`);
    }
  } else {
    const path = normalizeReplayProjectPath(scope.projectPath);
    let storedPath = `rtrim(replace(replace(${field("projectPath")}, char(92), '/'), '//wsl$/', '//wsl.localhost/'), '/')`;
    if (/^[a-z]:\//i.test(path)) storedPath = `lower(${storedPath})`;
    conditions.push("e.kind = 'snapshot'", `${storedPath} = ${bind(path)}`);
    conditions.push(`COALESCE(${field("environmentType")}, '') <> 'ssh'`);
  }
  if (options.kind && options.kind !== "all") conditions.push(`e.kind = ${bind(options.kind)}`);
  if (options.query?.trim()) {
    const query = bind(options.query.trim());
    conditions.push(`instr(lower(e.title || ' ' || COALESCE(e.detail, '') || ' ' || e.tags_json || ' ' || e.payload_json), lower(${query})) > 0`);
  }
  const limit = Math.max(1, Math.floor(options.limit ?? 100));
  return {
    sql: `SELECT e.* FROM ai_replay_events e LEFT JOIN ai_replay_sessions s ON s.session_key = e.session_key WHERE ${conditions.join(" AND ")} ORDER BY e.id DESC LIMIT ${bind(limit + 1)}`,
    values,
    limit,
  };
}
