import { type CSSProperties, type ReactNode, useCallback, useId, useMemo, useState } from "react";
import {
  Activity,
  AppWindow,
  ChevronDown,
  Copy,
  Cpu,
  Download,
  Gauge,
  HardDrive,
  ListOrdered,
  MemoryStick,
  Network,
  RefreshCw,
  Server,
  Upload,
} from "lucide-react";
import { useI18n } from "../../lib/i18n";
import {
  useSystemResources,
  type SystemResourceSnapshot,
  type SystemResourceSnapshotOptions,
} from "../../hooks/useSystemResources";
import {
  SYSTEM_RESOURCE_CARD_KEYS,
  useSettingsStore,
  type SystemResourceCardKey,
} from "../../stores/settingsStore";
import {
  EmptyHint,
  TERM_PANEL,
  panelColorTint,
} from "../stats/termStatsUi";
import { TerminalPanelHeader } from "./TerminalPanelHeader";
import { ResourceCardSettings } from "./ResourceCardSettings";

interface SystemResourcesPanelProps {
  open: boolean;
  visible?: boolean;
  embedded?: boolean;
  dashboard?: boolean;
  card?: SystemResourceCardKey;
  data?: ReturnType<typeof useSystemResources>;
  hideHeader?: boolean;
}

const PANEL_ACCENT = TERM_PANEL.green;
const PANEL_SOFT_FG = `color-mix(in srgb, ${TERM_PANEL.fg} 74%, ${TERM_PANEL.dim})`;
const NETWORK_UPLOAD_COLOR = `color-mix(in srgb, ${TERM_PANEL.green} 84%, ${TERM_PANEL.fg})`;
const NETWORK_DOWNLOAD_COLOR = `color-mix(in srgb, ${TERM_PANEL.blue} 82%, ${TERM_PANEL.cyan})`;
const DISK_READ_COLOR = `color-mix(in srgb, ${TERM_PANEL.green} 84%, ${TERM_PANEL.fg})`;
const DISK_WRITE_COLOR = `color-mix(in srgb, ${TERM_PANEL.blue} 82%, ${TERM_PANEL.cyan})`;
const MODULE_TITLE_COLOR = TERM_PANEL.fg;
const SYSTEM_RESOURCES_RUNTIME_CACHE_KEY = "system-resources-panel";

const PANEL_SCROLLBAR_STYLE = {
  "--ui-scrollbar-thumb": TERM_PANEL.border,
  "--ui-scrollbar-track": TERM_PANEL.bg,
} as CSSProperties;

const CARD_STYLE = {
  background: TERM_PANEL.card,
  borderColor: TERM_PANEL.border,
} satisfies CSSProperties;

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  return `${Math.max(0, value).toFixed(value >= 10 ? 0 : 1)}%`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function formatDiskBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0.0 B";
  const units = ["B", "K", "M", "G", "T"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "-";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}

function usageColor(value: number): string {
  if (value >= 86) return TERM_PANEL.red;
  if (value >= 62) return TERM_PANEL.yellow;
  return PANEL_ACCENT;
}

function usageTextColor(value: number): string {
  if (value >= 86) return TERM_PANEL.red;
  if (value >= 62) return TERM_PANEL.yellow;
  return TERM_PANEL.fg;
}

function cpuSegmentColor(segmentRatio: number): string {
  if (segmentRatio >= 0.86) return TERM_PANEL.red;
  if (segmentRatio >= 0.62) return TERM_PANEL.yellow;
  return TERM_PANEL.green;
}

function ResourceCard({
  icon,
  title,
  accent = MODULE_TITLE_COLOR,
  right,
  children,
}: {
  icon: ReactNode;
  title: string;
  accent?: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="ui-system-resource-card shrink-0" style={CARD_STYLE}>
      <div className="ui-system-resource-card__heading">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="ui-system-resource-card__icon"
            style={{
              color: accent,
            }}
          >
            {icon}
          </span>
          <h3 className="truncate text-[13px] font-medium" style={{ color: MODULE_TITLE_COLOR }}>
            {title}
          </h3>
        </div>
        {right ? <div className="ui-system-resource-card__value">{right}</div> : null}
      </div>
      {children}
    </section>
  );
}

function InlineEmpty({ text }: { text: string }) {
  return (
    <div className="rounded-lg border px-2.5 py-2 text-[11px]" style={{ borderColor: TERM_PANEL.border, color: TERM_PANEL.dim }}>
      {text}
    </div>
  );
}

interface TrendSeries {
  points: number[];
  color: string;
  mode?: "full" | "up" | "down";
  max?: number;
}

interface DiskTotals {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  readBytesPerSec: number;
  writeBytesPerSec: number;
}

function getDiskTotals(snapshot: SystemResourceSnapshot): DiskTotals {
  return snapshot.disks.reduce(
    (acc, disk) => ({
      totalBytes: acc.totalBytes + disk.totalBytes,
      usedBytes: acc.usedBytes + disk.usedBytes,
      availableBytes: acc.availableBytes + disk.availableBytes,
      readBytesPerSec: acc.readBytesPerSec + disk.readBytesPerSec,
      writeBytesPerSec: acc.writeBytesPerSec + disk.writeBytesPerSec,
    }),
    { totalBytes: 0, usedBytes: 0, availableBytes: 0, readBytesPerSec: 0, writeBytesPerSec: 0 }
  );
}

function TrendChart({
  series,
  height = 58,
  max,
  split = false,
  areaOpacity = 0.16,
  fadeStartOpacity = 0.4,
  fadeEndOpacity = 0.02,
}: {
  series: TrendSeries[];
  height?: number;
  max?: number;
  split?: boolean;
  areaOpacity?: number;
  fadeStartOpacity?: number;
  fadeEndOpacity?: number;
}) {
  const gradientId = useId();
  const allPoints = series.flatMap((line) => line.points);
  const scaleMax = Math.max(1, max ?? Math.max(1, ...allPoints));
  const safeSeries = series.map((line) => ({
    ...line,
    points: line.points.length >= 2 ? line.points : [line.points[0] ?? 0, line.points[0] ?? 0],
  }));
  const splitGapPx = 20;
  const splitBaselineOffset = (splitGapPx / 2 / Math.max(1, height - 2)) * 100;
  const splitUpBaseY = 50 - splitBaselineOffset;
  const splitDownBaseY = 50 + splitBaselineOffset;
  const splitAmplitude = 42 - splitBaselineOffset;
  const guideLines = split
    ? [
        { y: 8, dashed: false, strong: false },
        { y: 25, dashed: true, strong: false },
        { y: 50, dashed: false, strong: true },
        { y: 75, dashed: true, strong: false },
        { y: 92, dashed: false, strong: false },
      ]
    : [
        { y: 25, dashed: false, strong: false },
        { y: 50, dashed: false, strong: false },
        { y: 75, dashed: false, strong: false },
      ];

  const toCoords = (points: number[], mode: TrendSeries["mode"] = "full", seriesMax?: number) => points.map((point, index) => {
    const x = points.length === 1 ? 0 : (index / (points.length - 1)) * 100;
    const normalized = clampRatio(point / Math.max(1, seriesMax ?? scaleMax));
    const y = mode === "up"
      ? splitUpBaseY - normalized * splitAmplitude
      : mode === "down"
        ? splitDownBaseY + normalized * splitAmplitude
        : 90 - normalized * 72;
    return [x, y] as const;
  });

  const linePath = (coords: ReadonlyArray<readonly [number, number]>) => {
    if (coords.length < 2) {
      const [x = 0, y = 50] = coords[0] ?? [];
      return `M${x.toFixed(2)},${y.toFixed(2)}`;
    }

    const parts = [`M${coords[0][0].toFixed(2)},${coords[0][1].toFixed(2)}`];
    for (let index = 0; index < coords.length - 1; index += 1) {
      const [p0x, p0y] = coords[index - 1] ?? coords[index];
      const [p1x, p1y] = coords[index];
      const [p2x, p2y] = coords[index + 1];
      const [p3x, p3y] = coords[index + 2] ?? coords[index + 1];
      const c1x = p1x + (p2x - p0x) / 6;
      const c1y = p1y + (p2y - p0y) / 6;
      const c2x = p2x - (p3x - p1x) / 6;
      const c2y = p2y - (p3y - p1y) / 6;
      parts.push(`C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2x.toFixed(2)},${p2y.toFixed(2)}`);
    }
    return parts.join(" ");
  };

  const areaPath = (coords: ReadonlyArray<readonly [number, number]>, mode: TrendSeries["mode"] = "full") => {
    const baseY = mode === "up" ? splitUpBaseY : mode === "down" ? splitDownBaseY : 96;
    const first = coords[0];
    const last = coords[coords.length - 1];
    return `${linePath(coords)} L${last[0].toFixed(2)},${baseY} L${first[0].toFixed(2)},${baseY} Z`;
  };

  return (
    <div className="ui-resource-trend relative overflow-hidden" style={{ height, borderColor: TERM_PANEL.border, backgroundColor: TERM_PANEL.cardInner }}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full">
        <defs>
          <linearGradient id={`${gradientId}-fade`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="white" stopOpacity={fadeStartOpacity} />
            <stop offset="52%" stopColor="white" stopOpacity={Math.max(fadeEndOpacity, fadeStartOpacity * 0.42)} />
            <stop offset="100%" stopColor="white" stopOpacity={fadeEndOpacity} />
          </linearGradient>
          <mask id={`${gradientId}-mask`}>
            <rect width="100" height="100" fill={`url(#${gradientId}-fade)`} />
          </mask>
        </defs>
        {guideLines.map((guide) => (
          <line
            key={guide.y}
            x1="0"
            y1={guide.y}
            x2="100"
            y2={guide.y}
            stroke={guide.strong ? TERM_PANEL.dim : TERM_PANEL.border}
            strokeWidth={guide.strong ? "1" : "0.7"}
            vectorEffect="non-scaling-stroke"
            opacity={guide.strong ? "0.8" : "0.55"}
            strokeDasharray={guide.dashed ? "2 4" : undefined}
          />
        ))}
        {safeSeries.map((line, index) => {
          const coords = toCoords(line.points, line.mode, line.max);
          return (
            <g key={`${line.color}-${index}`}>
              <path d={areaPath(coords, line.mode)} fill={line.color} mask={`url(#${gradientId}-mask)`} opacity={areaOpacity} />
              <path d={linePath(coords)} fill="none" stroke={line.color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
            </g>
          );
        })}
      </svg>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6" style={{ background: `linear-gradient(to top, ${TERM_PANEL.card}, transparent)` }} />
    </div>
  );
}

function SystemCard({ snapshot }: { snapshot: SystemResourceSnapshot }) {
  const { t } = useI18n();
  const copyIp = useCallback(() => {
    if (!snapshot.ipAddress) return;
    void navigator.clipboard?.writeText(snapshot.ipAddress);
  }, [snapshot.ipAddress]);

  return (
    <ResourceCard
      icon={<Server size={15} />}
      title={t("systemResources.system")}
      accent={MODULE_TITLE_COLOR}
    >
      <dl className="ui-resource-system-metrics">
        <div><dt>{t("systemResources.os")}</dt><dd title={snapshot.osName}>{snapshot.osName || "—"}</dd></div>
        <div><dt>{t("systemResources.host")}</dt><dd title={snapshot.hostName ?? undefined}>{snapshot.hostName || "—"}</dd></div>
        <div><dt>{t("systemResources.cpu")}</dt><dd>{t("systemResources.cpuTopology", {
          cores: snapshot.cpu.physicalCoreCount,
          threads: snapshot.cpu.logicalProcessorCount,
        })}</dd></div>
        <div><dt>{t("systemResources.uptime")}</dt><dd>{formatUptime(snapshot.uptimeSeconds)}</dd></div>
        <div><dt>{t("systemResources.ip")}</dt><dd>{snapshot.ipAddress ? <button type="button" onClick={copyIp}
          className="ui-resource-copy-ip ui-focus-ring" title={t("systemResources.copyIp")} aria-label={t("systemResources.copyIp")}>
          {snapshot.ipAddress}<Copy size={11} aria-hidden="true" />
        </button> : "—"}</dd></div>
      </dl>
    </ResourceCard>
  );
}

function CpuCard({ snapshot, history }: { snapshot: SystemResourceSnapshot; history: SystemResourceSnapshot[] }) {
  const { t } = useI18n();
  const [coresExpanded, setCoresExpanded] = useState(false);
  const corePanelId = useId();
  const points = history.length > 0 ? history.map((item) => item.cpu.usagePercent) : [snapshot.cpu.usagePercent];
  const segmentCount = 14;

  return (
    <ResourceCard
      icon={<Cpu size={15} />}
      title={t("systemResources.cpu")}
      accent={MODULE_TITLE_COLOR}
      right={<span className="text-[12px] tabular-nums" style={{ color: TERM_PANEL.dim }}>{formatPercent(snapshot.cpu.usagePercent)}</span>}
    >
      <TrendChart
        series={[{ points, color: PANEL_ACCENT }]}
        height={72}
        max={100}
      />

      <button
        type="button"
        onClick={() => setCoresExpanded((value) => !value)}
        className="ui-resource-threads-trigger ui-focus-ring"
        style={{ borderColor: TERM_PANEL.border, backgroundColor: TERM_PANEL.cardInner, color: PANEL_SOFT_FG }}
        aria-expanded={coresExpanded}
        aria-controls={corePanelId}
        aria-label={coresExpanded ? t("systemResources.hideThreads") : t("systemResources.showThreads")}
      >
        <span>{t("systemResources.threadUnit", { count: snapshot.cpu.logicalProcessorCount })}</span>
        <ChevronDown
          size={13}
          className={`transition-transform ${coresExpanded ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>

      {coresExpanded ? (
        <div
          id={corePanelId}
          className="mt-2 grid gap-1.5"
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(96px, 1fr))" }}
        >
          {snapshot.cpuCores.map((core) => {
            const activeSegments = Math.max(1, Math.round(clampRatio(core.usagePercent / 100) * segmentCount));
            return (
              <div
                key={core.index}
                className="grid min-w-0 grid-cols-[14px_minmax(0,1fr)_34px] items-center gap-1.5 rounded-md border px-1.5 py-1"
                style={{ borderColor: TERM_PANEL.border, backgroundColor: TERM_PANEL.cardInner }}
              >
                <span className="text-[10px] tabular-nums" style={{ color: TERM_PANEL.dim }}>{core.index}</span>
                <span className="flex min-w-0 items-center gap-[2px] overflow-hidden">
                  {Array.from({ length: segmentCount }).map((_, index) => {
                    const segmentRatio = (index + 1) / segmentCount;
                    const active = index < activeSegments;
                    return (
                      <span
                        key={index}
                        className="h-[10px] w-[3px] shrink-0 rounded-[1px]"
                        style={{
                          backgroundColor: active ? cpuSegmentColor(segmentRatio) : panelColorTint(TERM_PANEL.fg, 10, TERM_PANEL.bg),
                          opacity: active ? 0.95 : 0.78,
                        }}
                      />
                    );
                  })}
                </span>
                <span className="text-right text-[10px] tabular-nums" style={{ color: TERM_PANEL.dim }}>
                  {formatPercent(core.usagePercent)}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
    </ResourceCard>
  );
}

function MemoryCard({ snapshot }: { snapshot: SystemResourceSnapshot }) {
  const { t } = useI18n();
  const total = snapshot.memory.totalBytes;
  const used = Math.min(total, Math.max(0, snapshot.memory.usedBytes));
  const percent = clampRatio(used / Math.max(1, total)) * 100;
  return (
    <ResourceCard icon={<MemoryStick size={15} />} title={t("resources.systemMemory")}
      right={<strong style={{ color: usageTextColor(percent) }}>{total > 0 ? formatPercent(percent) : "—"}</strong>}>
      {total <= 0 ? <InlineEmpty text={t("systemResources.unavailable")} /> : <>
        <div className="ui-resource-capacity"><strong>{formatBytes(used)}</strong><span>/ {formatBytes(total)}</span></div>
        <p className="ui-resource-description">{t("systemResources.used")} / {t("systemResources.total")}</p>
        <div className="ui-resource-capacity-bar" role="meter" aria-label={t("systemResources.memory")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
          <span style={{ width: percent + "%", background: usageColor(percent) }} />
        </div>
        <dl className="ui-resource-metrics">
          <div><dt>{t("systemResources.available")}</dt><dd>{formatBytes(snapshot.memory.availableBytes)}</dd></div>
          <div><dt>{t("systemResources.cache")}</dt><dd>{formatBytes(snapshot.memory.cachedBytes)}</dd></div>
          <div><dt>{t("systemResources.free")}</dt><dd>{formatBytes(snapshot.memory.freeBytes)}</dd></div>
        </dl>
      </>}
    </ResourceCard>
  );
}

function NetworkCard({ snapshot, history }: { snapshot: SystemResourceSnapshot; history: SystemResourceSnapshot[] }) {
  const { t } = useI18n();
  const samples = history.length ? history : [snapshot];
  return (
    <ResourceCard icon={<Network size={15} />} title={t("systemResources.network")}>
      <dl className="ui-resource-metrics ui-resource-metrics--pair">
        <div><dt><Upload size={11} />{t("systemResources.upload")}</dt><dd style={{ color: NETWORK_UPLOAD_COLOR }}>{formatRate(snapshot.network.uploadBytesPerSec)}</dd><small>{t("systemResources.todayTotal")} · {formatBytes(snapshot.network.todayUploadedBytes)}</small></div>
        <div><dt><Download size={11} />{t("systemResources.download")}</dt><dd style={{ color: NETWORK_DOWNLOAD_COLOR }}>{formatRate(snapshot.network.downloadBytesPerSec)}</dd><small>{t("systemResources.todayTotal")} · {formatBytes(snapshot.network.todayDownloadedBytes)}</small></div>
      </dl>
      <TrendChart height={72} series={[
        { points: samples.map(item => item.network.uploadBytesPerSec), color: NETWORK_UPLOAD_COLOR },
        { points: samples.map(item => item.network.downloadBytesPerSec), color: NETWORK_DOWNLOAD_COLOR },
      ]} />
    </ResourceCard>
  );
}

function DiskCard({ snapshot }: { snapshot: SystemResourceSnapshot; history: SystemResourceSnapshot[] }) {
  const { t } = useI18n();
  const totals = getDiskTotals(snapshot);
  const percent = clampRatio(totals.usedBytes / Math.max(1, totals.totalBytes)) * 100;
  return (
    <ResourceCard icon={<HardDrive size={15} />} title={t("systemResources.disk")}
      right={<strong>{snapshot.disks.length ? formatPercent(percent) : "—"}</strong>}>
      {!snapshot.disks.length ? <InlineEmpty text={t("systemResources.unavailable")} /> : <>
        <div className="ui-resource-capacity"><strong>{formatDiskBytes(totals.usedBytes)}</strong><span>/ {formatDiskBytes(totals.totalBytes)}</span></div>
        <p className="ui-resource-description">{t("systemResources.used")} / {t("systemResources.total")}</p>
        <div className="ui-resource-capacity-bar" role="meter" aria-label={t("systemResources.disk")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
          <span style={{ width: percent + "%", background: percent >= 94 ? TERM_PANEL.red : percent >= 86 ? TERM_PANEL.yellow : PANEL_ACCENT }} />
        </div>
        <dl className="ui-resource-metrics">
          <div><dt>{t("systemResources.available")}</dt><dd>{formatDiskBytes(totals.availableBytes)}</dd></div>
          <div><dt>{t("systemResources.readPerSecond")}</dt><dd style={{ color: DISK_READ_COLOR }}>{formatRate(totals.readBytesPerSec)}</dd></div>
          <div><dt>{t("systemResources.writePerSecond")}</dt><dd style={{ color: DISK_WRITE_COLOR }}>{formatRate(totals.writeBytesPerSec)}</dd></div>
        </dl>
        <div className="ui-resource-volumes">
          {snapshot.disks.map(disk => <div key={disk.mountPoint + disk.name}><span title={disk.name}>{disk.mountPoint || disk.name}<small>{disk.fileSystem}</small></span><strong>{formatDiskBytes(disk.usedBytes)} / {formatDiskBytes(disk.totalBytes)}</strong></div>)}
        </div>
      </>}
    </ResourceCard>
  );
}

function GpuCard({ snapshot, history }: { snapshot: SystemResourceSnapshot; history: SystemResourceSnapshot[] }) {
  const { t } = useI18n();
  const values = history.map(item => item.gpu?.usagePercent).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const usage = snapshot.gpu?.usagePercent ?? 0;
  const points = values.length ? values : [usage];
  const average = points.reduce((sum, value) => sum + value, 0) / points.length;
  return (
    <ResourceCard icon={<Gauge size={15} />} title={t("systemResources.gpu")}
      right={snapshot.gpu ? <strong style={{ color: usageTextColor(usage) }}>{formatPercent(usage)}</strong> : null}>
      {!snapshot.gpu ? <InlineEmpty text={t("systemResources.gpuUnavailable")} /> : <>
        <TrendChart series={[{ points, color: TERM_PANEL.magenta }]} height={72} max={100} />
        <dl className="ui-resource-metrics ui-resource-metrics--pair">
          <div><dt>{t("systemResources.average")}</dt><dd>{formatPercent(average)}</dd></div>
          <div><dt>{t("systemResources.peak")}</dt><dd>{formatPercent(Math.max(usage, ...points))}</dd></div>
        </dl>
      </>}
    </ResourceCard>
  );
}

function ProcessCard({ snapshot }: { snapshot: SystemResourceSnapshot }) {
  const { t } = useI18n();
  const rows = snapshot.topProcesses.slice(0, 5);

  return (
    <ResourceCard icon={<ListOrdered size={15} />} title={t("systemResources.topProcesses")} accent={MODULE_TITLE_COLOR}>
      {rows.length === 0 ? (
        <InlineEmpty text={t("systemResources.noProcesses")} />
      ) : (
        <div className="ui-resource-processes" style={{ borderColor: TERM_PANEL.border }}>
          <div className="grid grid-cols-[42px_42px_minmax(0,1fr)_44px] gap-2 border-b px-2 py-1.5 text-[10px] font-semibold" style={{ color: TERM_PANEL.dim, borderColor: TERM_PANEL.border, backgroundColor: TERM_PANEL.cardInner }}>
            <span>CPU</span>
            <span>{t("systemResources.memoryShort")}</span>
            <span>{t("systemResources.software")}</span>
            <span className="text-right">PID</span>
          </div>
          {rows.map((process) => {
            const command = process.command || process.name;
            const displayName = process.displayName?.trim() || command;
            const title = displayName === command ? displayName : `${displayName}\n${command}`;
            return (
              <div
                key={`${process.pid}-${process.name}`}
                className="grid grid-cols-[42px_42px_minmax(0,1fr)_44px] gap-2 border-b px-2 py-1.5 text-[11px] last:border-b-0"
                style={{ borderColor: panelColorTint(TERM_PANEL.border, 78), backgroundColor: TERM_PANEL.card }}
              >
                <span className="tabular-nums" style={{ color: TERM_PANEL.fg }}>{formatPercent(process.cpuUsagePercent)}</span>
                <span className="tabular-nums" style={{ color: TERM_PANEL.fg }}>{formatPercent(process.memoryUsagePercent)}</span>
                <span className="flex min-w-0 items-center gap-1.5" title={title} style={{ color: TERM_PANEL.fg }}>
                  {process.iconDataUrl ? (
                    <img src={process.iconDataUrl} alt="" width={16} height={16} className="shrink-0 rounded-[2px]" draggable={false} />
                  ) : (
                    <AppWindow size={14} className="shrink-0" aria-hidden="true" style={{ color: TERM_PANEL.dim }} />
                  )}
                  <span className="truncate">{displayName}</span>
                </span>
                <span className="truncate text-right tabular-nums" title={process.pid} style={{ color: TERM_PANEL.dim }}>{process.pid}</span>
              </div>
            );
          })}
        </div>
      )}
    </ResourceCard>
  );
}

export function SystemResourcesPanel({ open, visible = true, embedded = false, dashboard = false, card, data, hideHeader = false }: SystemResourcesPanelProps) {
  const { t } = useI18n();
  const panelActive = open && visible;
  const cardVisibility = useSettingsStore((s) => s.systemResourceCardVisibility);
  const cardOrder = useSettingsStore((s) => s.systemResourceCardOrder);

  const orderedCards = useMemo(() => {
    if (card) return [card];
    const configured = cardOrder.filter((key): key is SystemResourceCardKey => SYSTEM_RESOURCE_CARD_KEYS.includes(key));
    const missing = SYSTEM_RESOURCE_CARD_KEYS.filter((key) => !configured.includes(key));
    return [...configured, ...missing].filter((key) => cardVisibility[key]);
  }, [card, cardOrder, cardVisibility]);

  const samplingOptions = useMemo<SystemResourceSnapshotOptions>(() => ({
    fullDetail: true,
    system: cardVisibility.system,
    cpu: cardVisibility.cpu,
    memory: cardVisibility.memory,
    network: cardVisibility.network,
    disk: cardVisibility.disk,
    gpu: cardVisibility.gpu,
    processes: cardVisibility.processes,
  }), [cardVisibility]);

  const ownData = useSystemResources(
    panelActive && !data && orderedCards.length > 0,
    samplingOptions,
    2500,
    SYSTEM_RESOURCES_RUNTIME_CACHE_KEY
  );
  const { snapshot, history, loading, error, refresh } = data ?? ownData;

  const sampleTime = useMemo(() => {
    if (!snapshot?.sampledAt) return null;
    return new Date(snapshot.sampledAt).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }, [snapshot?.sampledAt]);

  if (!panelActive) return null;

  const containerClassName = card && embedded ? "ui-system-resource-detail font-sans" : embedded
    ? "flex h-full min-h-0 flex-col overflow-hidden font-sans"
    : "relative z-[1] flex w-[280px] shrink-0 flex-col overflow-hidden border-l border-border font-sans";

  const Container = embedded ? "div" : "aside";

  const renderCard = (key: SystemResourceCardKey) => {
    if (!snapshot) return null;
    switch (key) {
      case "system":
        return <SystemCard key={key} snapshot={snapshot} />;
      case "cpu":
        return <CpuCard key={key} snapshot={snapshot} history={history} />;
      case "memory":
        return <MemoryCard key={key} snapshot={snapshot} />;
      case "network":
        return <NetworkCard key={key} snapshot={snapshot} history={history} />;
      case "disk":
        return <DiskCard key={key} snapshot={snapshot} history={history} />;
      case "gpu":
        return <GpuCard key={key} snapshot={snapshot} history={history} />;
      case "processes":
        return <ProcessCard key={key} snapshot={snapshot} />;
      default:
        return null;
    }
  };

  return (
    <Container
      className={`${containerClassName}${dashboard ? " ui-resource-dashboard" : ""}`}
      style={{
        backgroundColor: TERM_PANEL.bg,
        ...PANEL_SCROLLBAR_STYLE,
      }}
    >
      {!hideHeader && <TerminalPanelHeader
        icon={<Server size={15} />}
        title={t("systemResources.title")}
        titleAccessory={(
          <span
            className="shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-semibold"
            style={{ color: PANEL_SOFT_FG, borderColor: TERM_PANEL.border, backgroundColor: TERM_PANEL.cardInner }}
          >
            {t("systemResources.localMachine")}
          </span>
        )}
        actions={(
          <>
          {sampleTime && <span className="text-[10px] tabular-nums" style={{ color: TERM_PANEL.dim }}>{sampleTime}</span>}
          <button
            type="button"
            onClick={() => void refresh(true)}
            className={`ui-terminal-panel-action ui-focus-ring rounded p-1 ${loading ? "animate-spin" : ""}`}
            style={{ color: TERM_PANEL.dim }}
            title={t("systemResources.refresh")}
            aria-label={t("systemResources.refresh")}
          >
            <RefreshCw size={12} />
          </button>
          </>
        )}
      />}

      {dashboard && <ResourceCardSettings />}

      <div
        className={card && embedded ? "ui-resource-detail-content" : `ui-thin-scroll min-h-0 flex-1 overflow-y-auto p-2 ${dashboard ? "ui-resource-dashboard-cards" : "flex flex-col gap-2.5"}`}
      >

      {orderedCards.length === 0 ? (
        <EmptyHint text={t("resources.cardsEmpty")} />
      ) : loading && !snapshot ? (
        <EmptyHint text={t("common.loading")} />
      ) : error && !snapshot ? (
        <EmptyHint text={t("systemResources.loadFailed")} />
      ) : snapshot ? (
        <>
          {orderedCards.map((key) => dashboard ? <div key={key} data-resource-card={key}>{renderCard(key)}</div> : renderCard(key))}

          {error ? (
            <div
              className="rounded-lg border px-2 py-1.5 text-[10px]"
              style={{
                borderColor: panelColorTint(TERM_PANEL.red, 24),
                color: TERM_PANEL.red,
                backgroundColor: panelColorTint(TERM_PANEL.red, 8),
              }}
            >
              <span className="inline-flex items-center gap-1"><Activity size={10} />{t("systemResources.refreshFailed")}</span>
            </div>
          ) : null}
        </>
      ) : null}
      </div>
    </Container>
  );
}
