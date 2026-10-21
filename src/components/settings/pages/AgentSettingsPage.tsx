import { useState } from "react";
import { SegmentedControl } from "@mantine/core";
import { toast } from "sonner";
import { CliToolIcon } from "../../CliToolIcon";
import { CLI_TOOL_DESCRIPTORS } from "../../../lib/cliTools";
import { applyAgentLaunchPermissions, type AgentPermissionMode } from "../../../lib/agentLaunchPermissions";
import { useI18n } from "../../../lib/i18n";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useInstalledCliTools } from "../../../hooks/useInstalledCliTools";

export function AgentSettingsPage() {
  const mode = useSettingsStore(s => s.agentPermissionMode);
  const update = useSettingsStore(s => s.update);
  const shell = useSettingsStore(s => s.defaultShell);
  const [saving, setSaving] = useState(false);
  const { t } = useI18n();
  const { commands, status, refresh } = useInstalledCliTools({ shell });
  const tools = CLI_TOOL_DESCRIPTORS.filter(tool => commands.includes(tool.command));

  const changeMode = async (value: string) => {
    setSaving(true);
    try {
      await update("agentPermissionMode", value as AgentPermissionMode);
    } catch (error) {
      toast.error(t("settings.agents.saveFailed"), { description: String(error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[960px] space-y-7">
      <section className="border-b border-border pb-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1 space-y-2">
            <h3 className="text-[14px] font-medium text-text-primary">{t("settings.agents.permissions")}</h3>
            <p className="max-w-[600px] text-[12px] leading-relaxed text-text-secondary">{t("settings.agents.description")}</p>
          </div>
          <SegmentedControl
            value={mode}
            onChange={value => { void changeMode(value); }}
            disabled={saving}
            aria-label={t("settings.agents.permissions")}
            data={[
              { value: "manual", label: t("settings.agents.manual") },
              { value: "yolo", label: "YOLO" },
            ]}
          />
        </div>
        <p className="mt-3 text-[12px] leading-relaxed text-text-muted">
          {t(mode === "yolo" ? "settings.agents.yoloDescription" : "settings.agents.manualDescription")}
        </p>
      </section>

      <section aria-label={t("settings.agents.commands")}>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className="text-[12px] font-medium text-text-secondary">{t("settings.agents.commands")}</h3>
          <button type="button" className="ui-focus-ring rounded px-2 py-1 text-[11px] text-text-secondary disabled:opacity-50" onClick={refresh} disabled={status === "loading"}>{t("cliTools.refresh")}</button>
        </div>
        {tools.length === 0 && <p role="status" className="py-3 text-[12px] text-text-muted">{t(status === "loading" ? "cliTools.scanning" : status === "error" ? "cliTools.scanFailed" : "settings.agents.noneInstalled")}</p>}
        <div className="divide-y divide-border">
          {tools.map(tool => (
            <div key={tool.id} className="flex items-center gap-3 py-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center text-text-secondary">
                <CliToolIcon icon={tool.icon} size={20} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-text-primary">{tool.label}</p>
                <code className="mt-1 block break-all text-[11px] leading-relaxed text-text-muted">
                  {applyAgentLaunchPermissions(tool.command, mode)}
                </code>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-4 text-[12px] leading-relaxed text-text-muted">{t("settings.agents.scope")}</p>
      </section>
    </div>
  );
}
