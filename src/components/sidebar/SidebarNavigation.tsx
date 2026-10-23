import { toast } from "sonner";
import { History, Layers, Search, TerminalSquare } from "lucide-react";
import { useHistoryStore } from "../../stores/historyStore";
import { useI18n } from "../../lib/i18n";
import type { SettingsTab } from "../SettingsModal";
import { useCommandPaletteStore } from "../CommandPalette";
import { useSettingsStore } from "../../stores/settingsStore";

export function SidebarNavigation({ collapsed, allTerminalsActive, onOpenSettings, onShowTerminals }: {
  collapsed: boolean;
  allTerminalsActive: boolean;
  onOpenSettings: (tab?: SettingsTab) => void;
  onShowTerminals: () => void;
}) {
  const { t } = useI18n();
  const shortcut = useSettingsStore(s => s.keyboardShortcuts.commandPalette);
  const historyOpen = useHistoryStore((s) => s.isOpen);
  const openHistory = () => {
    void useHistoryStore.getState().openHistory()
      .catch((error) => toast.error(t("sidebar.toast.openHistoryFailed"), { description: String(error) }));
  };
  return (
    <nav className="ui-sidebar-navigation" data-collapsed={collapsed} aria-label={t("workspace.label")}>
      <button type="button" className="ui-sidebar-nav-item ui-focus-ring"
        aria-label={t("palette.quickJump")} title={`${t("palette.quickJump")}${shortcut ? ` (${shortcut})` : ""}`}
        onClick={() => useCommandPaletteStore.getState().toggle()}>
        <Search size={14} aria-hidden="true" />{!collapsed && <><span>{t("palette.quickJump")}</span>
          {shortcut && <span className="ml-auto shrink-0 text-[11px] text-[var(--text-muted)]">{shortcut}</span>}</>}
      </button>
      <button type="button" className="ui-sidebar-nav-item ui-focus-ring" data-active={allTerminalsActive && !historyOpen}
        aria-current={allTerminalsActive && !historyOpen ? "page" : undefined}
        aria-label={t("sidebar.tree.allTerminals")} title={t("sidebar.tree.allTerminals")} onClick={() => {
        useHistoryStore.getState().closeHistory(); onShowTerminals();
      }}><Layers size={14} aria-hidden="true" />{!collapsed && <span>{t("sidebar.tree.allTerminals")}</span>}</button>
      <button type="button" className="ui-sidebar-nav-item ui-focus-ring" data-active={historyOpen}
        aria-current={historyOpen ? "page" : undefined} aria-label={t("workspace.historyNav")}
        title={t("workspace.historyNav")} onClick={openHistory}><History size={14} aria-hidden="true" />{!collapsed && <span>{t("workspace.historyNav")}</span>}</button>
      <button type="button" className="ui-sidebar-nav-item ui-focus-ring" aria-label={t("workspace.templatesNav")} title={t("workspace.templatesNav")}
        onClick={() => onOpenSettings("templates")}><TerminalSquare size={14} aria-hidden="true" />{!collapsed && <span>{t("workspace.templatesNav")}</span>}</button>
    </nav>
  );
}
