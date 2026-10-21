import { cloneElement, useId, type ReactElement, type ReactNode } from "react";
import { Tooltip } from "@mantine/core";
import { Info } from "lucide-react";
import { useI18n } from "../../lib/i18n";

interface ControlProps {
  id?: string;
  role?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}

interface SettingsFieldProps {
  label: string;
  description?: ReactNode;
  multiple?: boolean;
  status?: ReactNode;
  children: ReactElement<ControlProps>;
}

/** Keep options compact while retaining their labels and accessible descriptions. */
export function SettingsField({ label, description, multiple = false, status, children }: SettingsFieldProps) {
  const generatedId = useId();
  const id = children.props.id ?? generatedId;
  const descriptionId = `${id}-help`;
  const { t } = useI18n();
  return (
    <div className="ui-settings-field-row">
      <div className="ui-settings-field-label">
        {multiple ? <span>{label}</span> : <label htmlFor={id}>{label}</label>}
        {description && <>
          <Tooltip label={description} multiline w={260} withArrow events={{ hover: true, focus: true, touch: true }}>
            <button type="button" className="ui-settings-field-help ui-focus-ring" aria-label={t("settings.optionHelp", { label })}>
              <Info size={11} aria-hidden="true" />
            </button>
          </Tooltip>
          <span className="sr-only" id={descriptionId}>{description}</span>
        </>}
      </div>
      <div className="ui-settings-field-control">
        {cloneElement(children, {
          id,
          ...(multiple ? { role: "group" } : {}),
          "aria-label": children.props["aria-label"] ?? label,
          "aria-describedby": [children.props["aria-describedby"], status ? `${id}-status` : description ? descriptionId : null].filter(Boolean).join(" ") || undefined,
        })}
      </div>
      {status && <div className="ui-settings-field-status" id={`${id}-status`} role="status">{status}</div>}
    </div>
  );
}
