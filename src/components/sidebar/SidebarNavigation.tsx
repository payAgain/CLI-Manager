import { toast } from "sonner";
import { History, Layers, TerminalSquare } from "lucide-react";
import { useHistoryStore } from "../../stores/historyStore";
import { useI18n } from "../../lib/i18n";
import type { SettingsTab } from "../SettingsModal";

export function SidebarNavigation({ collapsed, onOpenSettings, onShowTerminals }: {
  collapsed: boolean;
  onOpenSettings: (tab?: SettingsTab) => void;
  onShowTerminals: () => void;
}) {
  const { t } = useI18n();
  const historyOpen = useHistoryStore((s) => s.isOpen);
  const openHistory = () => {
    void useHistoryStore.getState().openHistory()
      .catch((error) => toast.error(t("sidebar.toast.openHistoryFailed"), { description: String(error) }));
  };
  return (
    <nav className="ui-sidebar-navigation" data-collapsed={collapsed} aria-label={t("workspace.label")}>
      <button type="button" className="ui-sidebar-nav-item ui-focus-ring" title={t("sidebar.tree.allTerminals")} onClick={() => {
        useHistoryStore.getState().closeHistory(); onShowTerminals();
      }}><Layers size={14} />{!collapsed && <span>{t("sidebar.tree.allTerminals")}</span>}</button>
      <button type="button" className="ui-sidebar-nav-item ui-focus-ring" data-active={historyOpen}
        title={t("workspace.historyNav")} onClick={openHistory}><History size={14} />{!collapsed && <span>{t("workspace.historyNav")}</span>}</button>
      <button type="button" className="ui-sidebar-nav-item ui-focus-ring" title={t("workspace.templatesNav")}
        onClick={() => onOpenSettings("templates")}><TerminalSquare size={14} />{!collapsed && <span>{t("workspace.templatesNav")}</span>}</button>
    </nav>
  );
}
