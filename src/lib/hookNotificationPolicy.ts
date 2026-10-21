export interface HookNotificationWindowState {
  focused: boolean;
  visible: boolean;
  minimized: boolean;
  documentVisible: boolean;
  suppressWhileAppFocused: boolean;
}

export function suppressHookNotification(state: HookNotificationWindowState): boolean {
  const foreground = state.focused && state.visible && !state.minimized && state.documentVisible;
  return foreground && state.suppressWhileAppFocused;
}

/** Recheck window state and preferences after an asynchronous permission dialog. */
export async function deliverHookNotification(options: {
  suppressed: () => Promise<boolean>;
  permitted: () => Promise<boolean>;
  send: () => Promise<void>;
}): Promise<boolean> {
  if (await options.suppressed() || !await options.permitted() || await options.suppressed()) return false;
  await options.send();
  return true;
}
