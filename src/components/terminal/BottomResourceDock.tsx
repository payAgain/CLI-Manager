import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Cpu, Gauge, HardDrive, ListOrdered, MemoryStick, Network, Server, Settings2, type LucideIcon } from "lucide-react";
import { useSystemResources, type SystemResourceSnapshot, type SystemResourceSnapshotOptions } from "../../hooks/useSystemResources";
import { SYSTEM_RESOURCE_CARD_KEYS, useSettingsStore, type SystemResourceCardKey } from "../../stores/settingsStore";
import { useI18n } from "../../lib/i18n";
import { MemoryUsage, formatMemory } from "../sidebar/MemoryUsage";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { ResourceCardSettings, RESOURCE_CARD_LABELS } from "./ResourceCardSettings";
import { ResourceDetailPopover } from "./ResourceDetailPopover";
import { StatusBarButton } from "./StatusBarButton";

const SystemResourcesPanel = lazy(() => import("./SystemResourcesPanel").then(module => ({ default: module.SystemResourcesPanel })));
const ICONS: Record<SystemResourceCardKey, LucideIcon> = {
  system: Server, cpu: Cpu, memory: MemoryStick, network: Network, disk: HardDrive, gpu: Gauge, processes: ListOrdered,
};

function sampleValue(key: SystemResourceCardKey, snapshot: SystemResourceSnapshot): number | null {
  if (key === "cpu") return snapshot.cpu.usagePercent;
  if (key === "gpu") return snapshot.gpu?.usagePercent ?? null;
  if (key === "memory") return snapshot.memory.totalBytes > 0 ? snapshot.memory.usedBytes / snapshot.memory.totalBytes * 100 : null;
  if (key === "network") return snapshot.network.downloadBytesPerSec;
  if (key === "disk") {
    const total = snapshot.disks.reduce((sum, disk) => sum + disk.totalBytes, 0);
    return total > 0 ? snapshot.disks.reduce((sum, disk) => sum + disk.usedBytes, 0) / total * 100 : null;
  }
  return null;
}

export function BottomResourceDock() {
  const { t, language } = useI18n();
  const visibility = useSettingsStore(s => s.systemResourceCardVisibility);
  const order = useSettingsStore(s => s.systemResourceCardOrder);
  const [activeCard, setActiveCard] = useState<SystemResourceCardKey | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const keys = useMemo(() => Array.from(new Set([...order, ...SYSTEM_RESOURCE_CARD_KEYS]))
    .filter(key => SYSTEM_RESOURCE_CARD_KEYS.includes(key) && visibility[key]), [order, visibility]);
  const options = useMemo<SystemResourceSnapshotOptions>(() => ({
    fullDetail: false,
    system: visibility.system,
    cpu: visibility.cpu || activeCard === "system",
    memory: visibility.memory,
    network: visibility.network,
    disk: visibility.disk,
    gpu: visibility.gpu,
    // Enumerating processes and icons is only needed while that detail is open.
    processes: activeCard === "processes",
  }), [activeCard, visibility]);
  const data = useSystemResources(keys.length > 0, options, 5000, "workspace-resource-dock");
  const { snapshot, error, loading, refresh } = data;
  useEffect(() => {
    if (activeCard && !visibility[activeCard]) setActiveCard(null);
  }, [activeCard, visibility]);
  const sampleTime = snapshot ? new Date(snapshot.sampledAt).toLocaleTimeString(language, { hour12: false }) : "";

  const valueLabel = (key: SystemResourceCardKey) => {
    if (key === "system" || key === "processes") return "";
    if (!snapshot) return "—";
    const value = sampleValue(key, snapshot);
    if (value == null || !Number.isFinite(value)) return "—";
    return key === "network" ? "↓ " + formatMemory(value) + "/s" : Math.min(100, Math.max(0, value)).toFixed(0) + "%";
  };

  return (
    <div className="ui-bottom-resource-dock" aria-label={t("resources.title")}>
      <div className="ui-resource-memory-slot"><MemoryUsage collapsed={false} statusBar /></div>
      <div className="ui-resource-status-items" role="group" aria-label={t("systemResources.localMachine")}>
        {keys.map(key => {
          const Icon = ICONS[key];
          const label = t(RESOURCE_CARD_LABELS[key]);
          const value = valueLabel(key);
          const title = [label, value, key === "system" ? snapshot?.hostName : null, t("systemResources.localMachine")].filter(Boolean).join(" · ");
          return (
            <Popover key={key} open={activeCard === key} onOpenChange={open => {
              setActiveCard(open ? key : null);
              if (open) setSettingsOpen(false);
            }}>
              <PopoverTrigger asChild>
                <StatusBarButton className="ui-resource-status-item" data-resource={key}
                  data-stale={error ? "true" : undefined} aria-label={[label, value].filter(Boolean).join(" · ")}
                  title={title} icon={<Icon size={13} strokeWidth={1.5} />}
                  label={key !== "system" && key !== "processes" ? label : undefined}
                  reading={value || undefined} />
              </PopoverTrigger>
              <ResourceDetailPopover resource={key} title={label} icon={<Icon size={13} />} value={value}
                scope={t("systemResources.localMachine")} time={sampleTime} refreshLabel={t("systemResources.refresh")}
                onRefresh={() => void refresh(true)} refreshing={loading}>
                <Suspense fallback={<p className="ui-memory-note">{t("common.loading")}</p>}>
                  <SystemResourcesPanel open embedded card={key} data={data} hideHeader />
                </Suspense>
              </ResourceDetailPopover>
            </Popover>
          );
        })}
      </div>
      <Popover open={settingsOpen} onOpenChange={open => { setSettingsOpen(open); if (open) setActiveCard(null); }}>
        <PopoverTrigger asChild><StatusBarButton className="ui-resource-dock-settings" icon={<Settings2 size={13} strokeWidth={1.5} />}
          title={t("resources.customize")} aria-label={t("resources.customize")} /></PopoverTrigger>
        <PopoverContent side="top" align="end" className="ui-memory-popover ui-resource-settings-popover" aria-label={t("resources.customize")}>
          <ResourceCardSettings expanded />
        </PopoverContent>
      </Popover>
    </div>
  );
}
