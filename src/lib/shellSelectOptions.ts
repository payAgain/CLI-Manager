import { normalizeShellKey, type OsPlatform } from "./shell.ts";
import { getShellOptions, type ShellOption } from "./types.ts";

interface BuildShellSelectOptionsInput {
  shell: string;
  osPlatform: OsPlatform;
}

export function buildShellSelectOptions({
  shell,
  osPlatform,
}: BuildShellSelectOptionsInput): ShellOption[] {
  const normalizedShell = normalizeShellKey(shell);
  const isCustomShell = Boolean(shell && !normalizedShell);

  return [
    ...(isCustomShell ? [{ value: shell, label: `${shell}（当前自定义）` }] : []),
    ...getShellOptions(osPlatform),
  ];
}
