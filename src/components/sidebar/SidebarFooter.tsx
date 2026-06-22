import { BarChart3, Settings } from "../icons";
import { SyncStatusIndicator } from "./SyncStatusIndicator";
import type { SettingsTab } from "../SettingsModal";
import type { SidebarToolbarVisibilitySettings } from "../../stores/settingsStore";

interface SidebarFooterProps {
  collapsed: boolean;
  onOpenSettings: (tab?: SettingsTab) => void;
  onOpenStats: () => void;
  toolbarVisibility: SidebarToolbarVisibilitySettings;
}

export function SidebarFooter({ collapsed, onOpenSettings, onOpenStats, toolbarVisibility }: SidebarFooterProps) {
  const statsButton = toolbarVisibility.stats ? (
    <button
      onClick={onOpenStats}
      className="ui-focus-ring ui-icon-action ui-sidebar-action-stats"
      title="历史用量统计"
      aria-label="打开历史用量统计看板"
    >
      <BarChart3 size={14} strokeWidth={1.5} />
    </button>
  ) : null;

  const settingsButton = (
    <button
      onClick={() => onOpenSettings()}
      className="ui-focus-ring ui-icon-action ui-sidebar-action-settings"
      title="设置"
      aria-label="打开设置"
    >
      <Settings size={14} strokeWidth={1.5} />
    </button>
  );

  if (collapsed) {
    return (
      <div className="px-2 py-2">
        <div className="flex flex-col items-center gap-1.5">
          <SyncStatusIndicator collapsed onOpenSettings={onOpenSettings} />
          {statsButton}
          {settingsButton}
        </div>
      </div>
    );
  }

  return (
    <div className="px-2.5 py-2.5">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <SyncStatusIndicator onOpenSettings={onOpenSettings} />
        </div>
        {statsButton}
        {settingsButton}
      </div>
    </div>
  );
}
