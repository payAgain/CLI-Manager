import { SettingsField } from "../SettingsField";
import { useEffect, useMemo, useState } from "react";
import { Box, Button, Group, NumberInput, SegmentedControl, Select, Slider, Stack, Text, TextInput } from "@mantine/core";
import { RotateCcw } from "lucide-react";
import { debugConsoleWarn } from "../../../lib/debugConsole";
import {
  useSettingsStore,
  UI_FONT_SIZE_MAX,
  UI_FONT_SIZE_MIN,
  type DarkThemePalette,
  type LanguagePreference,
  type LightThemePalette,
  type ThemeMode,
} from "../../../stores/settingsStore";
import { LANGUAGE_OPTIONS, useI18n, type TranslationKey } from "../../../lib/i18n";
import {
  getContrastRatioFromHex,
  MIN_APPLY_CONTRAST_RATIO,
  MIN_READABLE_CONTRAST_RATIO,
} from "../../../lib/contrast";
import {
  listSystemFonts,
  mergeFontFamilyOptions,
  normalizeFontFamilyStack,
  type SystemFontFamily,
} from "../../../lib/systemFonts";
import { FontFamilySelect } from "../FontFamilySelect";
import { DataStorageSection } from "./DataStorageSection";

const LIGHT_PALETTE_OPTIONS: {
  value: LightThemePalette;
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
}[] = [
  {
    value: "warm-paper",
    labelKey: "settings.palette.light.warmPaper.label",
    descriptionKey: "settings.palette.light.warmPaper.description",
  },
  {
    value: "cream-green",
    labelKey: "settings.palette.light.creamGreen.label",
    descriptionKey: "settings.palette.light.creamGreen.description",
  },
  {
    value: "ink-red",
    labelKey: "settings.palette.light.inkRed.label",
    descriptionKey: "settings.palette.light.inkRed.description",
  },
  {
    value: "emerald-mist",
    labelKey: "settings.palette.light.emeraldMist.label",
    descriptionKey: "settings.palette.light.emeraldMist.description",
  },
  {
    value: "saas-analytics-dashboard",
    labelKey: "settings.palette.light.saasAnalyticsDashboard.label",
    descriptionKey: "settings.palette.light.saasAnalyticsDashboard.description",
  },
  {
    value: "apple-pure",
    labelKey: "settings.palette.light.applePure.label",
    descriptionKey: "settings.palette.light.applePure.description",
  },
  {
    value: "apple-mist",
    labelKey: "settings.palette.light.appleMist.label",
    descriptionKey: "settings.palette.light.appleMist.description",
  },
  {
    value: "apple-warm",
    labelKey: "settings.palette.light.appleWarm.label",
    descriptionKey: "settings.palette.light.appleWarm.description",
  },
  {
    value: "apple-mono",
    labelKey: "settings.palette.light.appleMono.label",
    descriptionKey: "settings.palette.light.appleMono.description",
  },
];

const DARK_PALETTE_OPTIONS: {
  value: DarkThemePalette;
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
}[] = [
  {
    value: "night-indigo",
    labelKey: "settings.palette.dark.nightIndigo.label",
    descriptionKey: "settings.palette.dark.nightIndigo.description",
  },
  {
    value: "forest-night",
    labelKey: "settings.palette.dark.forestNight.label",
    descriptionKey: "settings.palette.dark.forestNight.description",
  },
  {
    value: "graphite-red",
    labelKey: "settings.palette.dark.graphiteRed.label",
    descriptionKey: "settings.palette.dark.graphiteRed.description",
  },
  {
    value: "investment-platform",
    labelKey: "settings.palette.dark.investmentPlatform.label",
    descriptionKey: "settings.palette.dark.investmentPlatform.description",
  },
  {
    value: "github-dark",
    labelKey: "settings.palette.dark.githubDark.label",
    descriptionKey: "settings.palette.dark.githubDark.description",
  },
  {
    value: "catppuccin-mocha",
    labelKey: "settings.palette.dark.catppuccinMocha.label",
    descriptionKey: "settings.palette.dark.catppuccinMocha.description",
  },
  {
    value: "terminal-green",
    labelKey: "settings.palette.dark.terminalGreen.label",
    descriptionKey: "settings.palette.dark.terminalGreen.description",
  },
  {
    value: "dracula-purple",
    labelKey: "settings.palette.dark.draculaPurple.label",
    descriptionKey: "settings.palette.dark.draculaPurple.description",
  },
  {
    value: "carbon-black",
    labelKey: "settings.palette.dark.carbonBlack.label",
    descriptionKey: "settings.palette.dark.carbonBlack.description",
  },
];

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function clampUiFontSize(value: number) {
  if (!Number.isFinite(value)) return UI_FONT_SIZE_MIN;
  return Math.min(UI_FONT_SIZE_MAX, Math.max(UI_FONT_SIZE_MIN, value));
}

const LIGHT_TEXT_COLORS: Record<LightThemePalette, string> = {
  "warm-paper": "#302d28",
  "cream-green": "#293127",
  "ink-red": "#332c27",
  "emerald-mist": "#2b302a",
  "saas-analytics-dashboard": "#2b3038",
  "apple-pure": "#282828",
  "apple-mist": "#2b2e33",
  "apple-warm": "#302d28",
  "apple-mono": "#292928",
};

const DARK_TEXT_COLORS: Record<DarkThemePalette, string> = {
  "night-indigo": "#e8e8e9",
  "forest-night": "#e5e8e3",
  "graphite-red": "#ebe6e2",
  "investment-platform": "#e8e9eb",
  "github-dark": "#e6e8e9",
  "catppuccin-mocha": "#ebe7ed",
  "terminal-green": "#ecebe7",
  "dracula-purple": "#ece9ef",
  "carbon-black": "#ececec",
};

function getDefaultUiTextColor(
  resolvedTheme: "dark" | "light",
  lightPalette: LightThemePalette,
  darkPalette: DarkThemePalette
) {
  return resolvedTheme === "dark" ? DARK_TEXT_COLORS[darkPalette] : LIGHT_TEXT_COLORS[lightPalette];
}

// 与 themes.css 各配色块的 --bg-primary 保持一致（同 LIGHT_TEXT_COLORS 的维护方式）。
// 用纯映射而非 getComputedStyle：data-theme/data-*-palette 由 App.tsx 的 effect 在
// render 之后才更新，render 期间读 computed style 会在切换主题/配色时拿到旧背景色。
const LIGHT_BG_COLORS: Record<LightThemePalette, string> = {
  "warm-paper": "#faf9f6",
  "cream-green": "#f8faf6",
  "ink-red": "#faf8f6",
  "emerald-mist": "#fafaf8",
  "saas-analytics-dashboard": "#fafbfc",
  "apple-pure": "#ffffff",
  "apple-mist": "#fcfcfd",
  "apple-warm": "#faf9f6",
  "apple-mono": "#fcfcfb",
};

const DARK_BG_COLORS: Record<DarkThemePalette, string> = {
  "night-indigo": "#242426",
  "forest-night": "#232623",
  "graphite-red": "#272422",
  "investment-platform": "#232529",
  "github-dark": "#242628",
  "catppuccin-mocha": "#272529",
  "terminal-green": "#242423",
  "dracula-purple": "#27262b",
  "carbon-black": "#242424",
};

function getDefaultUiBgColor(
  resolvedTheme: "dark" | "light",
  lightPalette: LightThemePalette,
  darkPalette: DarkThemePalette
) {
  return resolvedTheme === "dark" ? DARK_BG_COLORS[darkPalette] : LIGHT_BG_COLORS[lightPalette];
}

const UI_FONT_FALLBACK = "\"PingFang SC\", \"Microsoft YaHei\", sans-serif";

const UI_FONT_FAMILY_OPTIONS: { value: string; label: string; labelKey?: TranslationKey }[] = [
  {
    value:
      "\"Segoe UI Variable\", \"Segoe UI\", -apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Microsoft YaHei\", sans-serif",
    label: "System Default (Segoe UI + CJK fallback)",
    labelKey: "settings.uiFont.systemDefault",
  },
  {
    value: "Inter, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif",
    label: "Inter",
  },
  {
    value: "\"HarmonyOS Sans\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif",
    label: "HarmonyOS Sans",
  },
  {
    value: "\"PingFang SC\", \"Microsoft YaHei\", sans-serif",
    label: "苹方 PingFang SC",
    labelKey: "settings.uiFont.pingFang",
  },
  {
    value: "\"Microsoft YaHei\", \"PingFang SC\", sans-serif",
    label: "微软雅黑 Microsoft YaHei",
    labelKey: "settings.uiFont.microsoftYaHei",
  },
  {
    value: "\"Source Han Sans SC\", \"Noto Sans CJK SC\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif",
    label: "思源黑体 / Source Han Sans",
    labelKey: "settings.uiFont.sourceHanSans",
  },
  {
    value: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
    label: "纯系统 UI 字体",
    labelKey: "settings.uiFont.systemUi",
  },
  {
    value: "\"Cascadia Code\", \"PingFang SC\", \"Microsoft YaHei\", monospace",
    label: "Cascadia Code",
  },
  {
    value: "\"JetBrains Mono\", \"PingFang SC\", \"Microsoft YaHei\", monospace",
    label: "JetBrains Mono",
  },
  {
    value: "\"Fira Code\", \"PingFang SC\", \"Microsoft YaHei\", monospace",
    label: "Fira Code",
  },
  {
    value: "Consolas, \"PingFang SC\", \"Microsoft YaHei\", monospace",
    label: "Consolas",
  },
  {
    value: "\"Courier New\", \"PingFang SC\", \"Microsoft YaHei\", monospace",
    label: "Courier New",
  },
];

export function GeneralSettingsPage() {
  const { t } = useI18n();
  const language = useSettingsStore((s) => s.language);
  const theme = useSettingsStore((s) => s.theme);
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);
  const lightThemePalette = useSettingsStore((s) => s.lightThemePalette);
  const darkThemePalette = useSettingsStore((s) => s.darkThemePalette);
  const uiFontFamily = useSettingsStore((s) => s.uiFontFamily);
  const uiFontSize = useSettingsStore((s) => s.uiFontSize);
  const uiTextColor = useSettingsStore((s) => s.uiTextColor);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const update = useSettingsStore((s) => s.update);
  const normalizedUiFontFamily = normalizeFontFamilyStack(uiFontFamily, UI_FONT_FALLBACK);
  const [uiFontSizeDraft, setUiFontSizeDraft] = useState(uiFontSize);
  const [uiTextColorDraft, setUiTextColorDraft] = useState(uiTextColor);
  const [systemFonts, setSystemFonts] = useState<SystemFontFamily[]>([]);
  const [systemFontsLoading, setSystemFontsLoading] = useState(false);
  const [systemFontsError, setSystemFontsError] = useState<string | null>(null);
  const themeOptions = useMemo<{ value: ThemeMode; label: string }[]>(
    () => [
      { value: "light", label: t("settings.options.theme.light") },
      { value: "dark", label: t("settings.options.theme.dark") },
      { value: "system", label: t("settings.options.theme.system") },
    ],
    [t]
  );
  useEffect(() => {
    let cancelled = false;
    setSystemFontsLoading(true);
    setSystemFontsError(null);

    void listSystemFonts()
      .then((fonts) => {
        if (!cancelled) setSystemFonts(fonts);
      })
      .catch((err) => {
        debugConsoleWarn("Failed to list system fonts:", err);
        if (!cancelled) setSystemFontsError(t("settings.general.uiFontError"));
      })
      .finally(() => {
        if (!cancelled) setSystemFontsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(() => {
    setUiFontSizeDraft(uiFontSize);
  }, [uiFontSize]);

  useEffect(() => {
    setUiTextColorDraft(uiTextColor);
  }, [uiTextColor]);

  const defaultUiTextColor = getDefaultUiTextColor(resolvedTheme, lightThemePalette, darkThemePalette);
  const normalizedUiTextColorDraft = uiTextColorDraft.trim();
  const uiTextColorDraftInvalid = normalizedUiTextColorDraft !== "" && !HEX_COLOR_PATTERN.test(normalizedUiTextColorDraft);
  const colorPickerValue = HEX_COLOR_PATTERN.test(normalizedUiTextColorDraft) ? normalizedUiTextColorDraft : defaultUiTextColor;
  const commitUiTextColor = (value = uiTextColorDraft) => {
    const next = value.trim();
    if (next !== "" && !HEX_COLOR_PATTERN.test(next)) return;
    if (next !== uiTextColor) {
      void update("uiTextColor", next);
    }
  };
  const commitUiFontSize = (value = uiFontSizeDraft) => {
    const next = clampUiFontSize(value);
    setUiFontSizeDraft(next);
    if (next !== uiFontSize) {
      void update("uiFontSize", next);
    }
  };
  // 对已提交的自定义颜色按当前配色的 --bg-primary（纯映射）计算对比度，
  // 给出可见反馈（消除“静默未应用”）；计算量极小，无需 memo。
  const uiBackgroundColor = getDefaultUiBgColor(resolvedTheme, lightThemePalette, darkThemePalette);
  const uiTextColorContrastRatio = uiTextColor ? getContrastRatioFromHex(uiTextColor, uiBackgroundColor) : null;
  let uiTextColorHint = t("settings.general.uiTextColorDefaultHint");
  let uiTextColorHintColor = "var(--text-muted)";
  if (uiTextColorDraftInvalid) {
    uiTextColorHint = t("settings.general.uiTextColorInvalid");
    uiTextColorHintColor = "var(--danger)";
  } else if (uiTextColorContrastRatio !== null && uiTextColorContrastRatio < MIN_APPLY_CONTRAST_RATIO) {
    uiTextColorHint = t("settings.general.uiTextColorTooClose");
    uiTextColorHintColor = "var(--danger)";
  } else if (uiTextColorContrastRatio !== null && uiTextColorContrastRatio < MIN_READABLE_CONTRAST_RATIO) {
    uiTextColorHint = t("settings.general.uiTextColorLowContrast");
    uiTextColorHintColor = "var(--warning)";
  }
  const uiFontFamilyOptions = useMemo(
    () =>
      mergeFontFamilyOptions(
        normalizedUiFontFamily,
        UI_FONT_FAMILY_OPTIONS.map((option) => ({
          value: option.value,
          label: option.labelKey ? t(option.labelKey) : option.label,
        })),
        systemFonts,
        UI_FONT_FALLBACK
      ),
    [systemFonts, t, normalizedUiFontFamily]
  );
  const showLightPalettes = theme === "light" || theme === "system";
  const showDarkPalettes = theme === "dark" || theme === "system";
  return (
    <Stack gap="md">
      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <Stack gap="md">
          <Text size="sm" fw={600} c="var(--on-surface)">
            {t("settings.general.appearance")}
          </Text>

          <SettingsField label={t("settings.general.language")} description={t("settings.general.languageDescription")}>
            <Select<LanguagePreference>
              value={language}
              onChange={(value) => {
                if (value) void update("language", value);
              }}
              data={LANGUAGE_OPTIONS}
              allowDeselect={false}
              size="xs"
              aria-label={t("settings.general.language")}
            />
          </SettingsField>

          <Stack gap={6} className="ui-settings-inline-choice">
            <Text size="xs" c="var(--on-surface-variant)">
              {t("settings.general.theme")}
            </Text>
            <SegmentedControl<ThemeMode>
              value={theme}
              onChange={(value) => void setTheme(value)}
              data={themeOptions}
              color="cliPrimary"
              fullWidth
              aria-label={t("settings.general.theme")}
            />
          </Stack>

          <Stack gap={8}>
            {showLightPalettes && (
              <SettingsField label={t("settings.general.lightTheme")} description={t((LIGHT_PALETTE_OPTIONS.find((option) => option.value === lightThemePalette) ?? LIGHT_PALETTE_OPTIONS[0]).descriptionKey)}>
                <Select<LightThemePalette>
                  value={lightThemePalette}
                  onChange={(value) => { if (value) void update("lightThemePalette", value); }}
                  data={LIGHT_PALETTE_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
                  allowDeselect={false}
                  size="xs"
                />
              </SettingsField>
            )}
            {showDarkPalettes && (
              <SettingsField label={t("settings.general.darkTheme")} description={t((DARK_PALETTE_OPTIONS.find((option) => option.value === darkThemePalette) ?? DARK_PALETTE_OPTIONS[0]).descriptionKey)}>
                <Select<DarkThemePalette>
                  value={darkThemePalette}
                  onChange={(value) => { if (value) void update("darkThemePalette", value); }}
                  data={DARK_PALETTE_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
                  allowDeselect={false}
                  size="xs"
                />
              </SettingsField>
            )}
          </Stack>

          <SettingsField label={t("settings.general.uiFont")} status={systemFontsError} description={systemFontsError ??
            t("settings.general.uiFontDescription", { count: systemFonts.length })}>
            <FontFamilySelect
              value={normalizedUiFontFamily}
              onChange={(value) => {
                if (value) void update("uiFontFamily", normalizeFontFamilyStack(value, UI_FONT_FALLBACK));
              }}
              data={uiFontFamilyOptions}
              maxDropdownHeight={320}
              nothingFoundMessage={systemFontsLoading ? t("settings.general.uiFontLoading") : t("settings.general.uiFontEmpty")}
              size="xs"
              aria-label={t("settings.general.uiFont")}
            />
          </SettingsField>

          <SettingsField label={t("settings.general.uiFontSize")} description={t("settings.general.uiFontSizeDescription")} multiple>
            <Group gap="xs" wrap="nowrap">
              <Slider
                style={{ flex: 1, minWidth: 60 }}
                min={UI_FONT_SIZE_MIN}
                max={UI_FONT_SIZE_MAX}
                step={1}
                value={uiFontSizeDraft}
                onChange={setUiFontSizeDraft}
                onChangeEnd={(value) => commitUiFontSize(value)}
                color="cliPrimary"
                aria-label={t("settings.general.uiFontSizeSlider")}
              />
              <NumberInput
                min={UI_FONT_SIZE_MIN}
                max={UI_FONT_SIZE_MAX}
                value={uiFontSizeDraft}
                onChange={(value) => setUiFontSizeDraft(typeof value === "number" ? value : Number(value))}
                onBlur={() => commitUiFontSize()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitUiFontSize();
                }}
                size="xs"
                w={64}
                aria-label={t("settings.general.uiFontSizeValue")}
              />
            </Group>
          </SettingsField>

          <SettingsField label={t("settings.general.uiTextColor")} description={uiTextColorHint} multiple
            status={uiTextColorHintColor !== "var(--text-muted)" ? <Text size="xs" c={uiTextColorHintColor}>{uiTextColorHint}</Text> : null}>
            <Stack gap={4}>
              <Group gap="xs" align="center" wrap="nowrap">
                <TextInput
                  type="color"
                  value={colorPickerValue}
                  onChange={(event) => {
                    // 原生取色器产出的总是合法 #rrggbb，onChange 直接提交实现实时生效；
                    // onBlur 保留作兜底（如浏览器实现差异导致 change 未触发）。
                    const value = event.currentTarget.value;
                    setUiTextColorDraft(value);
                    commitUiTextColor(value);
                  }}
                  onBlur={() => commitUiTextColor()}
                  w={32}
                  size="xs"
                  aria-label={t("settings.general.uiTextColorPicker")}
                  styles={{ input: { cursor: "pointer", padding: 4 } }}
                />
                <TextInput
                  value={uiTextColorDraft}
                  onChange={(event) => {
                    setUiTextColorDraft(event.currentTarget.value.trim());
                  }}
                  onBlur={() => commitUiTextColor()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      commitUiTextColor();
                    }
                  }}
                  placeholder={defaultUiTextColor}
                  size="xs"
                  w={106}
                  style={{ flex: 1, minWidth: 60 }}
                  aria-label={t("settings.general.uiTextColorHex")}
                  aria-invalid={uiTextColorDraftInvalid}
                  styles={{ input: { fontFamily: "var(--font-ui-mono)", fontSize: 12 } }}
                />
                {uiTextColor && (
                  <Button
                    type="button"
                    size="xs"
                    variant="light"
                    color="cliPrimary"
                    onClick={() => {
                      setUiTextColorDraft("");
                      void update("uiTextColor", "");
                    }}
                    className="shrink-0"
                    aria-label={t("settings.general.restoreThemeColor")}
                    title={t("settings.general.restoreThemeColor")}
                    style={{
                      backgroundColor: "color-mix(in srgb, var(--primary) 10%, transparent)",
                      border: "1px solid color-mix(in srgb, var(--primary) 22%, transparent)",
                      color: "var(--primary)",
                      paddingInline: 6,
                    }}
                  >
                    <RotateCcw size={12} />
                  </Button>
                )}
              </Group>
              <Group gap="xs" c="var(--text-muted)">
                <Box
                  w={10}
                  h={10}
                  style={{
                    backgroundColor: uiTextColor || defaultUiTextColor,
                    border: "1px solid var(--border)",
                    borderRadius: 999,
                  }}
                />
                <Text size="xs">
                  {uiTextColor
                    ? t("settings.general.currentCustomColor", { color: uiTextColor })
                    : t("settings.general.currentThemeColor", { color: defaultUiTextColor })}
                </Text>
              </Group>
            </Stack>
          </SettingsField>
        </Stack>
      </section>



      <DataStorageSection />


    </Stack>
  );
}
