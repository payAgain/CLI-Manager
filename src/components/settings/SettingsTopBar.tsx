import { TextInput } from "@mantine/core";
import { Search, X } from "../icons";
import { useI18n } from "../../lib/i18n";

interface SettingsTopBarProps {
  title: string;
  description: string;
  searchValue: string;
  searchPlaceholder?: string;
  onSearchChange: (nextValue: string) => void;
  onClose: () => void;
}

export function SettingsTopBar({
  title,
  description,
  searchValue,
  searchPlaceholder,
  onSearchChange,
  onClose,
}: SettingsTopBarProps) {
  const { t } = useI18n();

  return (
    <header className="ui-settings-topbar z-10">
      <div className="ui-settings-heading">
        <div className="min-w-0">
          <h2 className="text-on-surface">{title}</h2>
          <p>{description}</p>
        </div>
        {searchPlaceholder && (
          <TextInput
            value={searchValue}
            onChange={(event) => onSearchChange(event.currentTarget.value)}
            placeholder={searchPlaceholder}
            size="xs"
            leftSection={<Search size={12} strokeWidth={1.75} />}
            aria-label={t("settings.searchLabel")}
            className="ui-settings-topbar-search"
          />
        )}
        <button
          onClick={onClose}
          className="ui-settings-close ui-focus-ring"
          aria-label={t("settings.closeLabel")}
        >
          <X size={17} strokeWidth={1.6} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
