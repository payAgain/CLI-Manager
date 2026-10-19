// 当前会话上下文图使用固定、可区分的颜色。
export const HISTORY_SERIES_COLORS = {
  input: "#33B1FF",
  output: "#FF8389",
  cacheCreation: "#F1C21B",
  cacheRead: "#08BDBA",
} as const;

export const HISTORY_TREND_COLORS = {
  total: "#78A9FF",
  ...HISTORY_SERIES_COLORS,
} as const;

export const PEAK = "#F1C21B";

export const RECHARTS_AXIS_CURSOR = {
  stroke: "color-mix(in srgb, #33B1FF 36%, transparent)",
  strokeWidth: 1,
} as const;
