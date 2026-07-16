import type { SshHost } from "./types";

export interface SshConnectionSpecPayload {
  host: string;
  port: number;
  username: string;
  configAlias: string;
  authMode: string;
  identityFile: string;
  jumpTarget: string;
  proxyCommand: string;
  connectTimeoutSec: number;
  serverAliveIntervalSec: number;
  serverAliveCountMax: number;
}

function buildJumpTarget(host: SshHost | null | undefined): string {
  if (!host) return "";
  if (host.config_alias.trim()) return host.config_alias.trim();
  const address = host.host.trim();
  if (!address) return "";
  const normalizedAddress = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
  const userPrefix = host.username.trim() ? `${host.username.trim()}@` : "";
  const portSuffix = host.port && host.port !== 22 ? `:${host.port}` : "";
  return `${userPrefix}${normalizedAddress}${portSuffix}`;
}

export function buildSshConnectionSpec(
  host: SshHost,
  allHosts: SshHost[]
): SshConnectionSpecPayload {
  const jumpHost = host.jump_host_id
    ? allHosts.find((candidate) => candidate.id === host.jump_host_id)
    : null;
  return {
    host: host.host,
    port: host.port,
    username: host.username,
    configAlias: host.config_alias,
    authMode: host.auth_mode,
    identityFile: host.identity_file,
    jumpTarget: buildJumpTarget(jumpHost),
    proxyCommand: host.proxy_command,
    connectTimeoutSec: host.connect_timeout_sec,
    serverAliveIntervalSec: host.server_alive_interval_sec,
    serverAliveCountMax: host.server_alive_count_max,
  };
}
