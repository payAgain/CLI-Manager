import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { CLI_TOOL_DESCRIPTORS, type CliToolDescriptor } from "../../lib/cliTools";
import type { NewTerminalContext } from "../../lib/newTerminal";
import { buildSshConnectionSpec } from "../../lib/ssh";
import { useInstalledCliTools, type CliToolScanContext } from "../../hooks/useInstalledCliTools";
import { useSshHostStore } from "../../stores/sshHostStore";
import { useI18n } from "../../lib/i18n";
import { logError } from "../../lib/logger";
import { CliToolIcon } from "../CliToolIcon";
import { ChevronDown, Plus, RefreshCw, TerminalSquare } from "../icons";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

interface NewTerminalMenuProps {
  context: NewTerminalContext;
  onCreate: (tool: CliToolDescriptor | null) => Promise<void>;
  style?: CSSProperties;
}

export function NewTerminalMenu({ context, onCreate, style }: NewTerminalMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [hostFailed, setHostFailed] = useState(false);
  const hosts = useSshHostStore(s => s.hosts);
  const hostsLoaded = useSshHostStore(s => s.loaded);
  const fetchHosts = useSshHostStore(s => s.fetchHosts);
  const launching = useRef(false);

  useEffect(() => {
    if (!open || !context.remote || hostsLoaded) return;
    let cancelled = false;
    setHostFailed(false);
    void fetchHosts().catch(() => { if (!cancelled) setHostFailed(true); });
    return () => { cancelled = true; };
  }, [context.remote, fetchHosts, hostsLoaded, open]);

  const scanContext = useMemo<CliToolScanContext | null>(() => {
    if (!context.remote) return { cwd: context.cwd, shell: context.shell, envVars: context.envVars };
    const host = hosts.find(candidate => candidate.id === context.sshHostId);
    if (!host) return null;
    return { cwd: context.cwd, envVars: context.envVars, sshSpec: buildSshConnectionSpec(host, hosts) };
  }, [context, hosts]);
  const { commands, status, refresh } = useInstalledCliTools(scanContext, open);
  const tools = CLI_TOOL_DESCRIPTORS.filter(tool => commands.includes(tool.command));
  const failed = hostFailed || status === "error" || (context.remote && hostsLoaded && !scanContext);

  const create = (tool: CliToolDescriptor | null) => {
    launching.current = true;
    setOpen(false);
    void onCreate(tool).catch(error => logError("Failed to create terminal from menu", error));
  };
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
    items[next].focus();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="ui-focus-ring ui-icon-action ui-primary-action ui-action-new ui-new-terminal-trigger"
          aria-label={t("terminal.toolbar.newTerminal")} aria-haspopup="menu" data-active={open}>
          <Plus size={15} strokeWidth={2} />
          <ChevronDown size={9} strokeWidth={1.8} />
        </button>
      </PopoverTrigger>
      <PopoverContent role="menu" aria-label={t("terminal.toolbar.newTerminal")} align="end"
        className="ui-new-terminal-menu" style={style} onKeyDown={navigate}
        onCloseAutoFocus={event => { if (launching.current) { event.preventDefault(); launching.current = false; } }}>
        <button type="button" role="menuitem" className="ui-new-terminal-option ui-focus-ring" onClick={() => create(null)}>
          <TerminalSquare size={17} strokeWidth={1.6} />
          <span><strong>{t("sidebar.menu.newBlankTerminal")}</strong><small>{t("terminal.new.blankDescription")}</small></span>
        </button>
        <div className="ui-new-terminal-group">
          <span>{t("terminal.new.installedAgents")}</span>
          <button type="button" className="ui-focus-ring" aria-label={t("cliTools.refresh")} title={t("cliTools.refresh")}
            disabled={status === "loading"} onClick={() => { refresh(); if (context.remote && !hostsLoaded) void fetchHosts().catch(() => setHostFailed(true)); }}>
            <RefreshCw size={12} />
          </button>
        </div>
        <div className="ui-new-terminal-agents ui-thin-scroll">
          {tools.map(tool => (
            <button type="button" role="menuitem" className="ui-new-terminal-option ui-focus-ring" key={tool.id}
              aria-label={t("terminal.new.launchAgent", { name: tool.label })} onClick={() => create(tool)}>
              <CliToolIcon icon={tool.icon} size={17} />
              <span><strong>{tool.label}</strong><small>{tool.command}</small></span>
            </button>
          ))}
          {!tools.length && <p role="status">{t(failed ? "terminal.new.scanFailed" : status === "loading" || !hostsLoaded && context.remote
            ? "cliTools.scanning" : "terminal.new.noAgents")}</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
