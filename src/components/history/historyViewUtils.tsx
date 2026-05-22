import type { ReactNode } from "react";
import type { HistorySessionView } from "../../lib/types";

export type TimeGroupLabel = "Today" | "Yesterday" | "This Week" | "This Month" | "Earlier";

// 模块级 formatter 单例：toLocaleString 每次创建 ICU formatter，对长会话/列表的开销可观。
const TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "-";
  return TIME_FORMATTER.format(new Date(ts));
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 同会话搜索时 query 通常稳定，但 highlightText 会被每条可见消息调用一次，
// 每次都 `new RegExp` 是浪费。用 1-entry cache 复用上次编译的 regex。
let cachedQuery: string | null = null;
let cachedRegex: RegExp | null = null;
let cachedNormalized: string = "";

function getHighlightRegex(trimmed: string): { regex: RegExp; normalized: string } {
  if (cachedQuery === trimmed && cachedRegex) {
    return { regex: cachedRegex, normalized: cachedNormalized };
  }
  const regex = new RegExp(`(${escapeRegExp(trimmed)})`, "ig");
  cachedQuery = trimmed;
  cachedRegex = regex;
  cachedNormalized = trimmed.toLowerCase();
  return { regex, normalized: cachedNormalized };
}

const HIGHLIGHT_TEXT_MAX_LENGTH = 24_000;
const HIGHLIGHT_PARTS_MAX = 400;

export function highlightText(text: string, query: string): ReactNode {
  const trimmed = query.trim();
  if (!trimmed || text.length > HIGHLIGHT_TEXT_MAX_LENGTH) return text;
  const { regex, normalized } = getHighlightRegex(trimmed);
  const parts = text.split(regex);
  if (parts.length > HIGHLIGHT_PARTS_MAX) return text;
  return parts.map((part, idx) => {
    if (part.toLowerCase() === normalized) {
      return (
        <mark
          key={`${part}-${idx}`}
          className="rounded-sm px-0.5"
          style={{ backgroundColor: "var(--warning)", color: "var(--bg-primary)" }}
        >
          {part}
        </mark>
      );
    }
    return <span key={`${part}-${idx}`}>{part}</span>;
  });
}

export function makeSessionLabel(session: HistorySessionView): string {
  if (session.branch && session.branch.trim()) {
    return `${session.project_key} · ${session.branch}`;
  }
  return session.project_key;
}

export function toGroupLabel(ts: number, nowTs: number): TimeGroupLabel {
  if (!Number.isFinite(ts) || ts <= 0) return "Earlier";
  const todayStart = new Date(nowTs);
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  if (ts >= todayMs) return "Today";

  const yesterdayMs = todayMs - 24 * 60 * 60 * 1000;
  if (ts >= yesterdayMs) return "Yesterday";

  const day = todayStart.getDay();
  const mondayOffset = day === 0 ? 6 : day - 1;
  const weekMs = todayMs - mondayOffset * 24 * 60 * 60 * 1000;
  if (ts >= weekMs) return "This Week";

  const monthMs = new Date(todayStart.getFullYear(), todayStart.getMonth(), 1).getTime();
  if (ts >= monthMs) return "This Month";

  return "Earlier";
}

export function roleBadge(role: string): { label: string; color: string; bg: string; border: string } {
  const normalized = role.toLowerCase();
  if (normalized === "user") {
    return {
      label: "USER",
      color: "#1d4ed8",
      bg: "rgba(59, 130, 246, 0.12)",
      border: "rgba(59, 130, 246, 0.35)",
    };
  }
  if (normalized === "assistant") {
    return {
      label: "ASSISTANT",
      color: "#047857",
      bg: "rgba(16, 185, 129, 0.12)",
      border: "rgba(16, 185, 129, 0.3)",
    };
  }
  if (normalized === "system") {
    return {
      label: "SYSTEM",
      color: "#7c3aed",
      bg: "rgba(124, 58, 237, 0.12)",
      border: "rgba(124, 58, 237, 0.35)",
    };
  }
  return {
    label: normalized.toUpperCase(),
    color: "var(--text-secondary)",
    bg: "var(--bg-tertiary)",
    border: "var(--border)",
  };
}
