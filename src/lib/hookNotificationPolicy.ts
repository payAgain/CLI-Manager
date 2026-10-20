export interface HookNotificationWindowState {
  focused: boolean;
  visible: boolean;
  minimized: boolean;
  documentVisible: boolean;
  targetVisible: boolean;
  suppressWhileAppFocused: boolean;
}

export function suppressHookNotification(state: HookNotificationWindowState): boolean {
  const foreground = state.focused && state.visible && !state.minimized && state.documentVisible;
  return foreground && (state.targetVisible || state.suppressWhileAppFocused);
}

export function isNotificationTerminalVisible(tabId: string, root: Pick<Document, "querySelectorAll" | "querySelector">): boolean {
  // A modal covers the terminal even if its mounted pane retains layout state.
  if (root.querySelector('[aria-modal="true"]')) return false;
  return Array.from(root.querySelectorAll<HTMLElement>('[data-terminal-session-id]')).some((element) => (
    element.dataset.terminalSessionId === tabId
    && element.dataset.terminalVisible === "true"
    && element.getClientRects().length > 0
  ));
}

/** Recheck after the asynchronous permission dialog; returning to the terminal cancels delivery. */
export async function deliverBackgroundHookNotification(options: {
  suppressed: () => Promise<boolean>;
  permitted: () => Promise<boolean>;
  send: () => Promise<void>;
}): Promise<boolean> {
  if (await options.suppressed() || !await options.permitted() || await options.suppressed()) return false;
  await options.send();
  return true;
}
