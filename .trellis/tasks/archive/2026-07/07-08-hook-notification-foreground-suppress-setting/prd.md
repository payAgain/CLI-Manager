# Hook Notification Foreground Suppress Setting

## Goal

Add a user-facing Hook setting that controls whether OS-level Hook notifications are suppressed while CLI-Manager is open/active, without removing the existing global system notification switch.

Changelog Target: V1.2.6

## Confirmed Facts

- `src/App.tsx` sends OS-level Hook notifications from `sendSystemNotification(...)`.
- `src/App.tsx` keeps in-app Hook toast behavior separate via `showClaudeHookToast(...)`.
- `src/stores/settingsStore.ts` persists Hook notification settings:
  - `hookPopupNotificationsEnabled`
  - `systemNotificationsEnabled`
  - `systemNotificationEvents`
- `src/components/settings/pages/HookSettingsPage.tsx` already renders a "System Notifications" switch and per-event notification toggles.
- `src-tauri/capabilities/default.json` already has `core:window:allow-is-focused` after the previous implementation.

## Requirements

- Keep the existing `systemNotificationsEnabled` switch as the master OS notification switch.
- Add a second Hook setting for suppressing OS notifications when CLI-Manager's main window is focused/being used.
- The new setting must be persisted in `settingsStore`.
- The new setting must be visible in Settings -> Hook near the existing system notification switch.
- When the new setting is enabled and CLI-Manager's main window is focused, Hook events must still show the in-app Hook toast but must not send an OS-level notification.
- When the new setting is disabled, OS-level notifications follow the existing global and per-event settings.
- Add zh-CN and en-US copy for the new setting.
- Do not change hook scripts or backend notification command signatures.

## Acceptance Criteria

- [x] Settings -> Hook shows both OS notification controls:
  - global system notification enable/disable
  - focused-window suppression toggle
- [x] Default behavior suppresses OS notifications while CLI-Manager is focused, matching the previous implementation intent.
- [x] Disabling the new suppression toggle allows OS notifications even while CLI-Manager is focused.
- [x] In-app Hook toast and terminal tab status still update regardless of OS notification suppression.
- [x] `npx tsc --noEmit` passes.

## Validation

- `npx tsc --noEmit`
- `git diff --check`
- `Get-Content -Raw src-tauri/capabilities/default.json | ConvertFrom-Json`

## Decision

- "Open/active" means the main window is focused/being used. It does not mean merely visible while another application has focus.
