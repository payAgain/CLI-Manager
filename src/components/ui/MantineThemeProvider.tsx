import { MantineProvider, createTheme, type MantineColorsTuple } from "@mantine/core";
import { useMemo, type ReactNode } from "react";
import { useSettingsStore } from "../../stores/settingsStore";
import { normalizeFontFamilyStack } from "../../lib/systemFonts";

interface AppMantineThemeProviderProps {
  children: ReactNode;
}

function mixHex(hex: string, target: string, ratio: number): string {
  const parse = (value: string) => {
    const normalized = value.replace("#", "");
    return [0, 2, 4].map((i) => parseInt(normalized.slice(i, i + 2), 16));
  };
  const [r1, g1, b1] = parse(hex);
  const [r2, g2, b2] = parse(target);
  const mix = (a: number, b: number) => Math.round(a + (b - a) * ratio);
  return `#${[mix(r1, r2), mix(g1, g2), mix(b1, b2)]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

// Mantine 的 light/subtle 变体依赖完整色阶（浅色背景取 1、文字取 9）。
// 基色放在索引 6，深浅模式的实心控件使用对应的中性色。
function buildPrimaryShades(base: string): MantineColorsTuple {
  const WHITE_MIX = [0.93, 0.85, 0.75, 0.6, 0.4, 0.2];
  const BLACK_MIX = [0.12, 0.24, 0.38];
  return [
    ...WHITE_MIX.map((ratio) => mixHex(base, "#ffffff", ratio)),
    base,
    ...BLACK_MIX.map((ratio) => mixHex(base, "#000000", ratio)),
  ] as unknown as MantineColorsTuple;
}

export function AppMantineThemeProvider({ children }: AppMantineThemeProviderProps) {
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);
  const uiFontFamily = useSettingsStore((s) => s.uiFontFamily);
  const uiFontSize = useSettingsStore((s) => s.uiFontSize);
  const effectiveUiFontFamily = normalizeFontFamilyStack(uiFontFamily);
  const primaryColor = resolvedTheme === "dark" ? "#e8e7e3" : "#302e2a";

  const mantineTheme = useMemo(() => {
    const metaSize = Math.max(9, uiFontSize - 1);
    return createTheme({
      colors: {
        cliPrimary: buildPrimaryShades(primaryColor),
      },
      primaryColor: "cliPrimary",
      primaryShade: 6,
      autoContrast: true,
      fontFamily: effectiveUiFontFamily,
      fontFamilyMonospace: effectiveUiFontFamily,
      fontSizes: {
        xs: `${metaSize}px`,
        sm: `${uiFontSize + 1}px`,
        md: `${uiFontSize + 3}px`,
        lg: `${uiFontSize + 5}px`,
        xl: `${uiFontSize + 7}px`,
      },
      headings: {
        fontFamily: effectiveUiFontFamily,
      },
      defaultRadius: "sm",
      radius: { xs: "4px", sm: "6px", md: "8px", lg: "10px", xl: "12px" },
      defaultGradient: { from: "cliPrimary.6", to: "cliPrimary.6", deg: 0 },
    });
  }, [effectiveUiFontFamily, primaryColor, uiFontSize]);

  return (
    <MantineProvider theme={mantineTheme} defaultColorScheme={resolvedTheme} forceColorScheme={resolvedTheme}>
      {children}
    </MantineProvider>
  );
}
