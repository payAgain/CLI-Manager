import { useState, useEffect, useRef } from "react";
import "@mantine/core/styles.css";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { AppMantineThemeProvider } from "./ui/MantineThemeProvider";
import { SettingsLayout } from "./settings/SettingsLayout";
import { GeneralSettingsPage } from "./settings/pages/GeneralSettingsPage";
import { ThemeSettingsPage } from "./settings/pages/ThemeSettingsPage";
import { ShortcutSettingsPage } from "./settings/pages/ShortcutSettingsPage";
import { TemplateSettingsPage } from "./settings/pages/TemplateSettingsPage";
import { SyncSettingsPage } from "./settings/pages/SyncSettingsPage";
import { HookSettingsPage } from "./settings/pages/HookSettingsPage";
import { ProviderSettingsPage } from "./settings/pages/ProviderSettingsPage";
import { ModelPricingSettingsPage } from "./settings/pages/ModelPricingSettingsPage";
import { AboutSettingsPage } from "./settings/pages/AboutSettingsPage";
import { useSettingsStore } from "../stores/settingsStore";

export type SettingsTab =
  | "general"
  | "terminal-theme"
  | "shortcuts"
  | "templates"
  | "providers"
  | "model-pricing"
  | "sync"
  | "hooks"
  | "about";

interface SettingsTabConfig {
  label: string;
  title: string;
  description: string;
  searchPlaceholder?: string;
}

const SETTINGS_TAB_ORDER: SettingsTab[] = [
  "general",
  "terminal-theme",
  "shortcuts",
  "templates",
  "providers",
  "model-pricing",
  "sync",
  "hooks",
  "about",
];

const SETTINGS_TAB_CONFIG: Record<SettingsTab, SettingsTabConfig> = {
  general: {
    label: "通用",
    title: "通用设置",
    description: "配置应用主题、配色、界面字体、侧栏与行为偏好。",
  },
  "terminal-theme": {
    label: "终端设置",
    title: "终端设置",
    description: "配置终端行为、主题、字体、Shell、背景与实时预览。",
  },
  shortcuts: {
    label: "快捷键",
    title: "快捷键",
    description: "录制、取消和恢复默认快捷键绑定。",
    searchPlaceholder: "搜索快捷键",
  },
  templates: {
    label: "命令模板",
    title: "命令模板",
    description: "管理全局模板与项目模板的新增、编辑与删除。",
    searchPlaceholder: "搜索命令模板",
  },
  providers: {
    label: "供应商",
    title: "供应商 (cc-switch)",
    description: "只读解析 cc-switch 数据库，查看各 CLI 的 API 供应商配置。",
    searchPlaceholder: "搜索供应商",
  },
  "model-pricing": {
    label: "模型价格",
    title: "模型价格",
    description: "管理本地模型定价、识别历史模型，并从 LiteLLM / OpenRouter 同步候选价格。",
    searchPlaceholder: "搜索模型价格",
  },
  sync: {
    label: "同步",
    title: "同步",
    description: "选择云端（WebDAV）或本地目录方式同步配置。",
  },
  hooks: {
    label: "Hook 设置",
    title: "Hook 设置",
    description: "安装或移除 Claude Code 到 CLI-Manager 标签通知的桥接脚本。",
  },
  about: {
    label: "关于",
    title: "关于 CLI-Manager",
    description: "查看应用更新、项目介绍、开源地址、操作手册与作者信息。",
  },
};

interface Props {
  open: boolean;
  onClose: () => void;
  initialTab?: SettingsTab;
}

export function SettingsModal({ open, onClose, initialTab }: Props) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? "general");
  const [searchValue, setSearchValue] = useState("");
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const uiFontFamily = useSettingsStore((s) => s.uiFontFamily);
  useFocusTrap(dialogRef, mounted && !closing);

  useEffect(() => {
    if (open) {
      if (initialTab) setActiveTab(initialTab);
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const timer = setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, 180);
    return () => clearTimeout(timer);
  }, [open, mounted]);

  useEffect(() => {
    setSearchValue("");
  }, [activeTab]);

  useEffect(() => {
    if (!mounted || closing) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [mounted, closing, onClose]);

  if (!mounted) return null;

  const tabs = SETTINGS_TAB_ORDER.map((id) => ({ id, label: SETTINGS_TAB_CONFIG[id].label }));
  const activeConfig = SETTINGS_TAB_CONFIG[activeTab];
  const activeContent = (() => {
    if (activeTab === "general") return <GeneralSettingsPage />;
    if (activeTab === "terminal-theme") return <ThemeSettingsPage />;
    if (activeTab === "shortcuts") return <ShortcutSettingsPage searchValue={searchValue} />;
    if (activeTab === "templates") return <TemplateSettingsPage searchValue={searchValue} />;
    if (activeTab === "providers") return <ProviderSettingsPage searchValue={searchValue} />;
    if (activeTab === "model-pricing") return <ModelPricingSettingsPage searchValue={searchValue} />;
    if (activeTab === "sync") return <SyncSettingsPage />;
    if (activeTab === "hooks") return <HookSettingsPage />;
    if (activeTab === "about") return <AboutSettingsPage />;
    return null;
  })();

  return (
    <AppMantineThemeProvider>
      <div
        className={`fixed inset-x-0 bottom-0 top-[26px] z-50 ${
          closing ? "animate-fade-out" : "animate-fade-in"
        }`}
        style={{ fontFamily: uiFontFamily }}
        onClick={onClose}
      >
        <div
          ref={dialogRef}
          className={`ui-surface-base flex h-full w-full overflow-hidden${
            closing ? "" : " animate-slide-down"
          }`}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label="设置窗口"
        >
          <SettingsLayout
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            title={activeConfig.title}
            description={activeConfig.description}
            searchValue={searchValue}
            searchPlaceholder={activeConfig.searchPlaceholder}
            onSearchChange={setSearchValue}
            onClose={onClose}
          >
            {activeContent}
          </SettingsLayout>
        </div>
      </div>
    </AppMantineThemeProvider>
  );
}
