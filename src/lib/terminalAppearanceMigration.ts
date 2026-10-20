/** Upgrade only the previous default combination; explicitly selected themes remain intact. */
export function migrateDefaultTerminalAppearance(settings: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof settings.terminalAppearanceVersion === "number" && settings.terminalAppearanceVersion >= 1) return null;

  const patch: Record<string, unknown> = { terminalAppearanceVersion: 1 };
  // Older loads persisted the mode but could leave the default preset name absent.
  const hasLegacyAppearance = settings.terminalThemeName === "forestNightDark"
    || (settings.terminalThemeName === undefined && (
      settings.terminalThemeMode === "independent"
      || settings.lightThemePalette === "emerald-mist"
      || settings.darkThemePalette === "terminal-green"
    ));
  const oldDefaults = hasLegacyAppearance
    && (settings.terminalThemeMode === undefined || settings.terminalThemeMode === "independent")
    && (settings.lightThemePalette === undefined || settings.lightThemePalette === "emerald-mist")
    && (settings.darkThemePalette === undefined || settings.darkThemePalette === "terminal-green");

  if (oldDefaults) {
    Object.assign(patch, {
      terminalThemeMode: "system",
      terminalThemeName: "auto",
      lightThemePalette: "warm-paper",
      darkThemePalette: "carbon-black",
    });
  }
  return patch;
}
