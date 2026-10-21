import type { ReactNode } from "react";
import { Check } from "lucide-react";

interface SettingsChoiceItemProps {
  title: string;
  description?: string;
  preview?: ReactNode;
  selected: boolean;
  onClick: () => void;
}

export function SettingsChoiceItem({ title, description, preview, selected, onClick }: SettingsChoiceItemProps) {
  return (
    <button type="button" className="ui-settings-choice ui-focus-ring" data-selected={selected || undefined}
      aria-pressed={selected} title={description ? `${title}\n${description}` : title} onClick={onClick}>
      {preview}
      <span className="ui-settings-choice-copy">
        <span className="ui-settings-choice-title">{title}</span>
        {description && <span className="ui-settings-choice-description">{description}</span>}
      </span>
      {selected && <Check size={12} className="shrink-0 text-text-secondary" aria-hidden="true" />}
    </button>
  );
}
