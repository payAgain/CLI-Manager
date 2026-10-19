import { type ReactNode } from "react";
import { SettingsNav, type SettingsNavTab } from "./SettingsNav";
import { SettingsTopBar } from "./SettingsTopBar";

interface SettingsLayoutProps<T extends string> {
  tabs: SettingsNavTab<T>[];
  activeTab: T;
  onTabChange: (tab: T) => void;
  title: string;
  description: string;
  searchValue: string;
  searchPlaceholder?: string;
  onSearchChange: (nextValue: string) => void;
  onClose: () => void;
  children: ReactNode;
}

export function SettingsLayout<T extends string>({
  tabs,
  activeTab,
  onTabChange,
  title,
  description,
  searchValue,
  searchPlaceholder,
  onSearchChange,
  onClose,
  children,
}: SettingsLayoutProps<T>) {
  return (
    <div className="ui-settings-layout flex h-full min-h-0 w-full flex-1 flex-row">
      <SettingsNav tabs={tabs} activeTab={activeTab} onChange={onTabChange} />
      <section className="ui-surface-base flex min-w-0 flex-1 flex-col">
        <SettingsTopBar
          title={title}
          description={description}
          searchValue={searchValue}
          searchPlaceholder={searchPlaceholder}
          onSearchChange={onSearchChange}
          onClose={onClose}
        />
        <div className="ui-settings-content flex-1 overflow-y-auto [scrollbar-gutter:stable]">
          {children}
        </div>
      </section>
    </div>
  );
}
