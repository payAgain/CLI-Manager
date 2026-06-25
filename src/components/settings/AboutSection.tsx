import { useEffect, useState, type ComponentType } from "react";
import {
  AlertCircle,
  AlertTriangle,
  BookOpen,
  Check,
  Download,
  ExternalLink,
  Github,
  Info,
  RefreshCw,
  RotateCw,
  UserRound,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTerminalStore } from "../../stores/terminalStore";
import { useUpdateStore } from "../../stores/updateStore";
import { MarkdownContent } from "../ui/MarkdownContent";

const REPOSITORY_URL = "https://github.com/dark-hxx/CLI-Manager";
const MANUAL_URL = `${REPOSITORY_URL}/blob/master/docs/%E5%8A%9F%E8%83%BD%E6%B8%85%E5%8D%95.md`;
const AUTHOR_URL = "https://github.com/dark-hxx";

const PROJECT_HIGHLIGHTS = [
  "多项目 PTY 终端管理",
  "Claude Code / Codex CLI 集成",
  "历史会话 Diff 与用量分析",
  "供应商切换与 WebDAV 同步",
];

interface ExternalLinkItemProps {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  url: string;
}

async function openExternalUrl(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch (e) {
    console.error("Failed to open URL:", e);
  }
}

function ExternalLinkItem({ icon: Icon, title, description, url }: ExternalLinkItemProps) {
  return (
    <button
      type="button"
      onClick={() => void openExternalUrl(url)}
      className="ui-interactive ui-focus-ring ui-surface-card flex min-w-0 items-start gap-3 rounded-2xl border border-border p-4 text-left transition-colors hover:bg-surface-container-high"
    >
      <span className="flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-surface-container-high text-primary">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-on-surface">
          {title}
          <ExternalLink className="h-3.5 w-3.5 text-on-surface-variant" />
        </span>
        <span className="mt-1 block text-xs leading-5 text-on-surface-variant">{description}</span>
      </span>
    </button>
  );
}

export function AboutSection() {
  const {
    currentVersion,
    checking,
    updateAvailable,
    updateInfo,
    downloading,
    downloadProgress,
    downloadTotalBytes,
    downloadedBytes,
    readyToInstall,
    installing,
    lastCheckedAt,
    error,
    releaseFallbackUrl,
    fetchVersion,
    checkUpdate,
    downloadUpdate,
    installAndRelaunch,
    reset,
  } = useUpdateStore();
  const activeTerminalCount = useTerminalStore((state) =>
    state.sessions.filter((session) => {
      const status = state.sessionStatuses[session.id];
      return status !== "exited" && status !== "error";
    }).length
  );
  const [installConfirmVisible, setInstallConfirmVisible] = useState(false);

  useEffect(() => {
    if (!currentVersion) {
      fetchVersion();
    }
  }, [currentVersion, fetchVersion]);

  useEffect(() => {
    if (!readyToInstall) {
      setInstallConfirmVisible(false);
    }
  }, [readyToInstall, updateInfo?.version]);

  const handleCheckUpdate = () => {
    if (checking || downloading || installing) return;
    setInstallConfirmVisible(false);
    checkUpdate();
  };

  const handleDownloadUpdate = async () => {
    if (downloading || installing) return;
    const downloaded = await downloadUpdate();
    if (downloaded) {
      setInstallConfirmVisible(true);
    }
  };

  const handleOpenReleaseFallback = () => {
    void openExternalUrl(updateInfo?.downloadUrl ?? releaseFallbackUrl);
  };

  const handleConfirmInstall = () => {
    if (installing) return;
    installAndRelaunch();
  };

  const formatDate = (dateStr: string) => {
    if (!dateStr) return "";
    try {
      return new Date(dateStr).toLocaleDateString("zh-CN", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    } catch {
      return dateStr;
    }
  };

  const formatBytes = (value: number | null) => {
    if (!value || value <= 0) return "";
    const units = ["B", "KB", "MB", "GB"];
    let size = value;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }
    return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
  };

  const canDownload = updateAvailable && updateInfo && !downloading && !readyToInstall && !installing;
  const showLatest = Boolean(lastCheckedAt && !checking && !error && !updateAvailable);
  const progressLabel = downloadTotalBytes
    ? `${downloadProgress}%（${formatBytes(downloadedBytes)} / ${formatBytes(downloadTotalBytes)}）`
    : downloadProgress > 0
      ? `${downloadProgress}%`
      : "正在下载...";

  return (
    <div className="space-y-4">
      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 flex-none items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Info className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-on-surface">项目介绍</div>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-on-surface-variant">
              CLI-Manager 是面向 Claude Code / Codex CLI 的跨平台 AI CLI 增强工作台，用于集中管理多项目终端、会话历史、Diff 回看、用量分析、供应商切换和配置同步。
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {PROJECT_HIGHLIGHTS.map((item) => (
                <span
                  key={item}
                  className="rounded-full border border-border bg-surface-container-high px-2.5 py-1 text-xs text-on-surface-variant"
                >
                  {item}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <div className="text-sm font-semibold text-on-surface">应用更新</div>

        <div className="mt-3 flex items-center justify-between">
          <span className="text-xs text-on-surface-variant">版本号</span>
          <span className="rounded-md bg-surface-container-high px-2 py-0.5 font-mono text-xs font-semibold text-on-surface">
            V{currentVersion || "---"}
          </span>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleCheckUpdate}
            disabled={checking || downloading || installing}
            className="ui-interactive ui-focus-ring flex items-center gap-1.5 rounded-lg border border-border bg-surface-container-high px-3 py-1.5 text-xs font-medium text-on-surface transition-colors hover:bg-surface-container-highest disabled:cursor-not-allowed disabled:opacity-60"
            aria-label={checking ? "检查中" : "检查更新"}
          >
            {checking ? (
              <>
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                <span>检查中...</span>
              </>
            ) : (
              <>
                <RefreshCw className="h-3.5 w-3.5" />
                <span>检查更新</span>
              </>
            )}
          </button>

          {error && (
            <div className="flex flex-wrap items-center gap-1 text-xs text-danger">
              <AlertCircle className="h-3.5 w-3.5" />
              <span>{error}</span>
              <button type="button" onClick={handleCheckUpdate} className="ml-1 underline hover:no-underline">
                重试
              </button>
              <button type="button" onClick={handleOpenReleaseFallback} className="ml-1 underline hover:no-underline">
                查看 Release
              </button>
            </div>
          )}

          {showLatest && (
            <div className="flex items-center gap-1 text-xs text-success">
              <Check className="h-3.5 w-3.5" />
              <span>已是最新版本</span>
            </div>
          )}
        </div>

        {updateAvailable && updateInfo && (
          <div className="mt-3 rounded-xl border border-accent/30 bg-accent/5 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-on-surface">V{updateInfo.version}</span>
                  <span className="rounded-full bg-success/20 px-2 py-0.5 text-[10px] font-medium text-success">
                    新版本可用
                  </span>
                </div>
                {updateInfo.releaseDate && (
                  <div className="mt-1 text-xs text-on-surface-variant">
                    发布日期：{formatDate(updateInfo.releaseDate)}
                  </div>
                )}
              </div>
              <div className="flex flex-col items-end gap-2">
                {canDownload && (
                  <button
                    type="button"
                    onClick={handleDownloadUpdate}
                    className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>下载更新</span>
                  </button>
                )}
                {readyToInstall && !installConfirmVisible && (
                  <button
                    type="button"
                    onClick={() => setInstallConfirmVisible(true)}
                    className="flex items-center gap-1.5 rounded-lg bg-success px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
                  >
                    <RotateCw className="h-3.5 w-3.5" />
                    <span>安装并重启</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleOpenReleaseFallback}
                  className="flex items-center gap-1 text-xs text-on-surface-variant underline hover:no-underline"
                >
                  <ExternalLink className="h-3 w-3" />
                  <span>查看 Release 页面</span>
                </button>
              </div>
            </div>

            {downloading && (
              <div className="mt-3 rounded-lg border border-border/60 bg-surface-container-high/60 p-3">
                <div className="mb-2 flex items-center justify-between text-xs text-on-surface-variant">
                  <span>正在下载更新</span>
                  <span>{progressLabel}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-surface-container-highest">
                  <div
                    className="h-full rounded-full bg-accent transition-all"
                    style={{ width: `${downloadProgress}%` }}
                  />
                </div>
              </div>
            )}

            {readyToInstall && installConfirmVisible && (
              <div className="mt-3 rounded-lg border border-danger/40 bg-danger/10 p-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-danger" />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold text-on-surface">确认安装并重启</div>
                    <div className="mt-1 text-xs text-on-surface-variant">
                      安装更新会关闭并重启 CLI-Manager。
                      {activeTerminalCount > 0
                        ? ` 当前仍有 ${activeTerminalCount} 个运行中的终端会话，继续操作会中断其中的任务。`
                        : " 请确认当前工作已保存。"}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={handleConfirmInstall}
                        disabled={installing}
                        className="rounded-lg bg-danger px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {installing ? "正在安装..." : "确认安装并重启"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setInstallConfirmVisible(false)}
                        disabled={installing}
                        className="rounded-lg border border-border bg-surface-container-high px-3 py-1.5 text-xs font-medium text-on-surface transition-colors hover:bg-surface-container-highest disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        稍后
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {updateInfo.releaseNotes && (
              <div className="mt-3 border-t border-border/50 pt-3">
                <div className="mb-1 text-xs font-medium text-on-surface-variant">更新说明</div>
                <MarkdownContent content={updateInfo.releaseNotes} linkBehavior="open" />
              </div>
            )}

            <button
              type="button"
              onClick={reset}
              disabled={checking || downloading || installing}
              className="mt-3 text-xs text-on-surface-variant underline hover:no-underline disabled:cursor-not-allowed disabled:opacity-60"
            >
              稍后提醒
            </button>
          </div>
        )}
      </section>

      <div className="space-y-3">
        <div className="px-1 text-sm font-semibold text-on-surface">项目资源</div>
        <div className="grid gap-3 md:grid-cols-2">
          <ExternalLinkItem
            icon={Github}
            title="Git 开源地址"
            description="查看源码、提交 Issue 或参与 Pull Request。"
            url={REPOSITORY_URL}
          />
          <ExternalLinkItem
            icon={BookOpen}
            title="操作手册"
            description="查看功能清单、使用说明和能力边界。"
            url={MANUAL_URL}
          />
        </div>
      </div>

      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 flex-none items-center justify-center rounded-2xl bg-surface-container-high text-primary">
            <UserRound className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-on-surface">作者信息</div>
            <div className="mt-2 text-sm text-on-surface-variant">作者：hxx / dark-hxx</div>
            <div className="mt-1 text-xs leading-5 text-on-surface-variant">
              项目长期围绕 AI CLI 工作流、终端体验、历史会话分析和多项目管理持续演进。
            </div>
            <button
              type="button"
              onClick={() => void openExternalUrl(AUTHOR_URL)}
              className="ui-interactive ui-focus-ring mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-container-high px-3 py-1.5 text-xs font-medium text-on-surface transition-colors hover:bg-surface-container-highest"
            >
              <Github className="h-3.5 w-3.5" />
              <span>查看作者主页</span>
              <ExternalLink className="h-3 w-3 text-on-surface-variant" />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
