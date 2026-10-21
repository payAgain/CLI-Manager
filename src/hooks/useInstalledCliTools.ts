import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CLI_TOOL_COMMANDS } from "../lib/cliTools";
import type { SshConnectionSpecPayload } from "../lib/ssh";

export interface CliToolScanContext {
  shell?: string;
  cwd?: string;
  envVars?: Record<string, string>;
  sshSpec?: SshConnectionSpecPayload;
}

const EMPTY: string[] = [];
interface ScanState {
  key: string;
  commands: string[];
  status: "loading" | "ready" | "error";
}

/** Each result belongs to one Shell/host/environment. Old requests never populate a new context. */
export function useInstalledCliTools(context: CliToolScanContext | null, enabled = true) {
  const [revision, setRevision] = useState(0);
  const contextKey = context ? JSON.stringify(context) : "";
  const requestKey = `${contextKey}:${revision}`;
  const [state, setState] = useState<ScanState>({ key: "", commands: EMPTY, status: "loading" });
  const refresh = useCallback(() => setRevision(value => value + 1), []);

  useEffect(() => {
    if (!enabled || !contextKey) return;
    let cancelled = false;
    setState({ key: requestKey, commands: EMPTY, status: "loading" });
    const timer = window.setTimeout(() => {
      const parsed: CliToolScanContext = JSON.parse(contextKey);
      void invoke<string[]>("cli_tools_scan", {
        shell: parsed.shell || null,
        cwd: parsed.cwd || null,
        envVars: parsed.envVars ?? null,
        sshSpec: parsed.sshSpec ?? null,
      }).then(commands => {
        if (cancelled) return;
        const installed = new Set(Array.isArray(commands) ? commands : []);
        setState({ key: requestKey, commands: CLI_TOOL_COMMANDS.filter(command => installed.has(command)), status: "ready" });
      }).catch(() => {
        if (!cancelled) setState({ key: requestKey, commands: EMPTY, status: "error" });
      });
    }, 200);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [contextKey, enabled, requestKey]);

  return {
    commands: state.key === requestKey ? state.commands : EMPTY,
    status: !context ? "unavailable" as const : state.key === requestKey ? state.status : "loading" as const,
    refresh,
  };
}
