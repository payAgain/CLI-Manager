# Statusline Editor Contracts

## 1. Scope / Trigger

- Applies to the Settings > Statusline designer, Claude widget editor, Codex native item editor, and terminal-style preview.

## 2. Signatures

    type StatuslineEditorSource = "claude" | "codex";
    interface StatuslinePreviewState { themeId: string; width: number }

`StatuslinePreview` accepts rendered text, preview state, change callback, empty text and aria label.

## 3. Contracts

- Claude and Codex drafts, selected items and preview state are independent.
- Claude catalog additions target the explicitly active line; every placed widget has a direct remove action, and selected widgets can move across lines without requiring drag-and-drop.
- Claude/Codex statusline sorting must use the project's `@dnd-kit` PointerSensor pattern, not HTML5 `draggable`; Tauri `dragDropEnabled` intercepts native WebView drag/drop on Windows. Claude dragging must accept empty line containers and show the current target line before drop.
- Tool switching must not copy or normalize one tool's configuration into the other.
- Claude and Codex keep independent named profile lists. Switching one tool's active profile must not affect the other tool.
- Profile save and switch apply immediately. Switching away from a dirty draft requires save/discard/cancel handling; the active profile cannot be deleted.
- On first adoption, the editor displays the parsed actual configuration instead of replacing it with defaults. Valid external drift is offered as a new profile and never silently overwrites the active snapshot.
- Whole-library import/export is shared at page level. Import conflicts are resolved per profile before a single commit, and import never auto-switches the active profile.
- Claude preview consumes backend ANSI output; Codex preview consumes ordered official placeholder values.
- Preview values include localized status names for explanation only; this must not imply that Codex native labels are configurable or change live output.
- Codex preview is rendered directly below the Codex native statusline title/path header and before the selected/available item editors.
- Color selectors show a swatch plus persistent Chinese and English names. Powerline settings expose font status/install, enablement, alignment, theme continuation, separator, caps and theme selection.
- Claude preview renders each backend newline as a separate terminal row; preview-only payload fixtures must provide deterministic values for environment-dependent widgets such as Git status.
- Preview theme defaults to the current terminal theme and may temporarily select any `TERMINAL_THEME_PRESETS` entry without changing global terminal settings.
- Editor surfaces use project semantic variables (`--surface-container-*`, `--on-surface-*`, `--primary`, `--interactive-*`); provider colors are badges only.
- Layout is three columns at wide widths, two columns with a full-width property panel at medium widths, and one column on narrow widths.

## 4. Validation & Error Matrix

| Condition | Behavior |
|---|---|
| Preview width outside 60–180 | Clamp to the supported range |
| Unknown ANSI code | Preserve text and ignore unsupported style |
| Unknown Codex item loaded | Keep its id visible so the user can remove it |
| Save fails | Keep draft and dirty indicator; show localized toast |
| No items selected | Show localized empty preview |

## 5. Good/Base/Bad Cases

- Good: switching app palettes recolors all editor surfaces while the preview remains on its selected terminal theme.
- Base: an unchanged config disables Save and shows no dirty badge.
- Bad: hard-coded black/white cards become unreadable in light or warm themes.
- Bad: switching from Claude to Codex discards the Claude draft.

## 6. Tests Required

- Type-check source switching, preview props and persisted source setting.
- Verify dirty state before/after save and after save failure.
- Verify Codex drag ordering and Claude cross-line ordering.
- Smoke-test dark, light, warm and high-contrast application palettes plus light/dark terminal preview themes.
- Verify keyboard controls, focus rings and localized aria labels.

## 7. Wrong vs Correct

### Wrong

    <Card className="bg-black text-white" />

### Correct

    <Card className="bg-surface-container-low text-on-surface" />
