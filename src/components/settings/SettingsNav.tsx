import type { LucideIcon } from "lucide-react";
import { useI18n } from "../../lib/i18n";

export interface SettingsNavTab<T extends string> {
  id: T;
  label: string;
  icon: LucideIcon;
}

interface SettingsNavProps<T extends string> {
  tabs: SettingsNavTab<T>[];
  activeTab: T;
  onChange: (tab: T) => void;
}

export function SettingsNav<T extends string>({ tabs, activeTab, onChange }: SettingsNavProps<T>) {
  const { t } = useI18n();

  return (
    <aside className="ui-settings-nav">
      <span className="ui-settings-nav-title">
        {t("settings.navTitle")}
      </span>
      <nav>
        {tabs.map((tab) => {
          const active = tab.id === activeTab;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => onChange(tab.id)}
              className="ui-settings-nav-item ui-focus-ring"
              data-selected={active ? "true" : "false"}
              aria-label={tab.label}
              title={tab.label}
              aria-pressed={active}
            >
              <Icon size={16} strokeWidth={1.6} aria-hidden="true" />
              <span className="ui-settings-nav-label">{tab.label}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
