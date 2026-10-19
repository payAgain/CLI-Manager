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
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h2 className="text-on-surface">{title}</h2>
          <p>{description}</p>
        </div>
        <button
          onClick={onClose}
          className="ui-settings-close ui-focus-ring"
          aria-label={t("settings.closeLabel")}
        >
          <X size={17} strokeWidth={1.6} aria-hidden="true" />
        </button>
        {searchPlaceholder && (
          <TextInput
            value={searchValue}
            onChange={(event) => onSearchChange(event.currentTarget.value)}
            placeholder={searchPlaceholder}
            size="xs"
            leftSection={<Search size={14} strokeWidth={1.75} />}
            aria-label={t("settings.searchLabel")}
            className="col-span-2 min-w-0 min-[1280px]:ml-auto min-[1280px]:w-56"
          />
        )}
      </div>
    </header>
  );
}
