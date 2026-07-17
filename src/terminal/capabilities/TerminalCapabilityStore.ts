export const enum TerminalCapability {
  CwdDetection = "cwdDetection",
  CommandDetection = "commandDetection",
  PartialCommandDetection = "partialCommandDetection",
  BufferMarkDetection = "bufferMarkDetection",
  PromptTypeDetection = "promptTypeDetection",
  ShellEnvironmentDetection = "shellEnvironmentDetection",
  AltBufferDetection = "altBufferDetection",
  CliProviderDetection = "cliProviderDetection",
  TaskStatusDetection = "taskStatusDetection",
}

export interface TerminalCapabilityChange<T = object> {
  capability: TerminalCapability;
  value: T;
}

type CapabilityListener = (change: TerminalCapabilityChange) => void;

/** Typed runtime capability registry modeled after VS Code's terminal capability store. */
export class TerminalCapabilityStore {
  private readonly values = new Map<TerminalCapability, object>();
  private readonly listeners = new Set<CapabilityListener>();

  add<T extends object>(capability: TerminalCapability, value: T): void {
    this.values.set(capability, value);
    this.emit({ capability, value });
  }

  get<T extends object>(capability: TerminalCapability): T | undefined {
    return this.values.get(capability) as T | undefined;
  }

  has(capability: TerminalCapability): boolean {
    return this.values.has(capability);
  }

  remove(capability: TerminalCapability): void {
    const value = this.values.get(capability);
    if (!value) return;
    this.values.delete(capability);
    this.emit({ capability, value });
  }

  subscribe(listener: CapabilityListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.values.clear();
    this.listeners.clear();
  }

  private emit(change: TerminalCapabilityChange): void {
    this.listeners.forEach((listener) => listener(change));
  }
}
