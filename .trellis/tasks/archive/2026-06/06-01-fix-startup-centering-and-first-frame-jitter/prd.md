# Fix startup centering and first-frame jitter

## Goal

Improve startup polish for the Tauri desktop app: the main window should open centered, avoid the initial white flash, and avoid the visible left/right layout shift after settings load.

## Requirements

- Center the main Tauri window on startup.
- Use a non-white native/WebView startup background that matches the default dark app surface.
- Avoid rendering the sidebar/terminal layout until persisted settings are loaded, so saved `sidebarWidth` / `viewMode` do not cause a visible first-frame reflow.
- Keep the change minimal: no new dependencies, no IPC changes, no layout refactor.

## Acceptance Criteria

- [ ] Fresh app window opens at screen center instead of the top-left corner.
- [ ] Startup does not show a white WebView flash before React/CSS paints.
- [ ] Sidebar and terminal do not visibly shift horizontally after startup settings load.
- [ ] TypeScript check passes with `npx tsc --noEmit`.

## Definition of Done

- Typecheck passes.
- Relevant startup UI path is manually reviewed or noted if browser/Tauri runtime verification is unavailable.
- No new dependency or capability expansion.

## Technical Approach

- Add `center: true` and `backgroundColor` to `src-tauri/tauri.conf.json` main window config.
- Add minimal inline document background CSS in `index.html` for the pre-React/pre-CSS frame.
- In `src/App.tsx`, read `settingsStore.loaded` and render only the workspace shell until settings are ready.

## Decision (ADR-lite)

**Context**: Current startup renders with default settings, then persisted settings update `viewMode` / sidebar width, causing a visible layout shift. Tauri window config also lacks explicit centering and native background color.

**Decision**: Use Tauri config for native startup behavior and gate the React main layout on persisted settings readiness.

**Consequences**: Startup may show a brief blank app-colored shell while settings load, but avoids white flash and left/right reflow without broader architecture changes.

## Out of Scope

- Window bounds persistence.
- Splash screen implementation.
- Terminal rendering refactor.
- Theme-specific pre-React background persistence.

## Technical Notes

- Relevant files inspected: `src-tauri/tauri.conf.json`, `index.html`, `src/App.tsx`, `src/App.css`, `src/stores/settingsStore.ts`, `src/components/sidebar/index.tsx`.
- Tauri 2 docs confirm `center` and `backgroundColor` are window options.
- Frontend spec index points to `quality-guidelines.md`; no specific startup guideline exists.
