import { ArrowDown, ArrowUp, Settings2 } from "lucide-react";
import { useI18n, type TranslationKey } from "../../lib/i18n";
import { SYSTEM_RESOURCE_CARD_KEYS, useSettingsStore, type SystemResourceCardKey } from "../../stores/settingsStore";

export const RESOURCE_CARD_LABELS: Record<SystemResourceCardKey, TranslationKey> = {
  system: "systemResources.system", cpu: "systemResources.cpu", memory: "resources.systemMemory",
  network: "systemResources.network", disk: "systemResources.disk", gpu: "systemResources.gpu", processes: "systemResources.topProcesses",
};

export function ResourceCardSettings({ expanded = false }: { expanded?: boolean }) {
  const { t } = useI18n();
  const order = useSettingsStore((s) => s.systemResourceCardOrder);
  const visibility = useSettingsStore((s) => s.systemResourceCardVisibility);
  const update = useSettingsStore((s) => s.update);
  const move = (index: number, direction: number) => {
    const next = [...order];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    void update("systemResourceCardOrder", next);
  };
  return (
    <details className="ui-resource-card-settings" open={expanded || undefined}>
      <summary><Settings2 size={13} /><span>{t("resources.customize")}</span><span className="ui-resource-card-count">{order.filter((key) => visibility[key]).length}/{order.length}</span></summary>
      <div className="ui-resource-card-settings-list">
        {order.map((key, index) => {
          const item = t(RESOURCE_CARD_LABELS[key]);
          return (
            <div className="ui-resource-card-setting" key={key}>
              <span>{item}</span>
              <button type="button" disabled={index === 0} className="ui-flat-action ui-focus-ring" onClick={() => move(index, -1)} aria-label={t("settings.sidebar.moveResourceCardUp", { item })}><ArrowUp size={12} /></button>
              <button type="button" disabled={index === order.length - 1} className="ui-flat-action ui-focus-ring" onClick={() => move(index, 1)} aria-label={t("settings.sidebar.moveResourceCardDown", { item })}><ArrowDown size={12} /></button>
              <input type="checkbox" role="switch" checked={visibility[key]} onChange={(event) => void update("systemResourceCardVisibility", { ...visibility, [key]: event.target.checked })} aria-label={t(visibility[key] ? "settings.sidebar.hideResourceCard" : "settings.sidebar.showResourceCard", { item })} />
            </div>
          );
        })}
      </div>
      <div className="ui-resource-card-settings-actions">
        <button type="button" className="ui-flat-action ui-focus-ring" onClick={() => void update("systemResourceCardOrder", [...SYSTEM_RESOURCE_CARD_KEYS])}>{t("settings.sidebar.resetResourceCardOrder")}</button>
        <button type="button" className="ui-flat-action ui-focus-ring" onClick={() => void update("systemResourceCardVisibility", Object.fromEntries(SYSTEM_RESOURCE_CARD_KEYS.map((key) => [key, true])) as Record<SystemResourceCardKey, boolean>)}>{t("settings.sidebar.showAllResourceCards")}</button>
      </div>
    </details>
  );
}
