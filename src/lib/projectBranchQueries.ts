import type { ProjectEnvironmentType } from "./types";

export interface BranchQueryTarget { key: string; path: string }

/** WSL paths remain case-sensitive after their host/distro; native Windows paths do not. */
export function projectBranchTarget(path: string | null | undefined, environment: ProjectEnvironmentType = "local"): BranchQueryTarget | null {
  if (!path || environment === "ssh") return null;
  let normalized = path.replace(/\\/g, "/").replace(/^\/\/\?\/UNC\//i, "//");
  const wsl = /^\/\/(?:wsl\$|wsl\.localhost)\/([^/]+)(\/.*)?$/i.exec(normalized);
  if (wsl) normalized = `//wsl.localhost/${wsl[1].toLowerCase()}${wsl[2] ?? "/"}`;
  else if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")) normalized = normalized.toLowerCase();
  normalized = normalized.replace(/\/{2,}/g, (_slashes, offset: number) => offset === 0 ? "//" : "/");
  if (normalized !== "/" && !/^[a-z]:\/$/.test(normalized)) normalized = normalized.replace(/\/+$/, "");
  return { key: `${wsl ? "wsl" : environment}:${normalized}`, path };
}

interface Entry {
  target: BranchQueryTarget;
  branch: string | null;
  listeners: Set<() => void>;
  queued: boolean;
  pending: boolean;
  nextReadAt: number;
}

/** One read and one notification stream per checkout, independent of pane/sidebar count. */
export function createProjectBranchQueries(options: {
  read: (path: string) => Promise<string | null>;
  now?: () => number;
  maxConcurrent?: number;
  intervalMs?: number;
}) {
  const entries = new Map<string, Entry>();
  const queue: Entry[] = [];
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? 15_000;
  let running = 0;
  let enabled = true;
  const drain = () => {
    while (enabled && running < (options.maxConcurrent ?? 4) && queue.length) {
      const entry = queue.shift()!;
      entry.queued = false;
      if (!entry.listeners.size) { entries.delete(entry.target.key); continue; }
      entry.pending = true;
      running++;
      void options.read(entry.target.path).then(branch => {
        if (entry.branch === branch) return;
        entry.branch = branch;
        for (const listener of entry.listeners) listener();
      }).catch(() => {
        // Transient filesystem failures retain the last valid branch.
      }).finally(() => {
        running--;
        entry.pending = false;
        entry.nextReadAt = now() + intervalMs;
        if (!entry.listeners.size) entries.delete(entry.target.key);
        drain();
      });
    }
  };
  const request = (entry: Entry, force = false) => {
    if (entry.pending || entry.queued || !entry.listeners.size || (!force && now() < entry.nextReadAt)) return;
    entry.queued = true;
    queue.push(entry);
    drain();
  };
  return {
    subscribe(target: BranchQueryTarget, listener: () => void) {
      let entry = entries.get(target.key);
      if (!entry) {
        entry = { target, branch: null, listeners: new Set(), queued: false, pending: false, nextReadAt: 0 };
        entries.set(target.key, entry);
      }
      entry.listeners.add(listener);
      request(entry);
      return () => {
        entry.listeners.delete(listener);
        if (!entry.listeners.size && !entry.pending && !entry.queued) entries.delete(target.key);
      };
    },
    getSnapshot: (target: BranchQueryTarget | null) => target ? entries.get(target.key)?.branch ?? null : null,
    refresh(force = false) { for (const entry of entries.values()) request(entry, force); },
    setEnabled(value: boolean) { enabled = value; if (enabled) drain(); },
  };
}
