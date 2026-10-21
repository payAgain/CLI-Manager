import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowDown, ArrowUpLeft, Brain, Check, ChevronRight, Circle, CircleX, FileText, GitBranch, Globe, MessageSquare, Terminal, Wrench } from "lucide-react";
import { buildSubagentTranscriptRows, mergeSubagentMessages, parseSubagentTranscript, subagentToolSummary, type SubagentTranscriptActivity, type SubagentTranscriptCursor, type SubagentTranscriptMessage } from "../../lib/subagentTranscript";
import { debugConsoleWarn } from "../../lib/debugConsole";
import { useI18n } from "../../lib/i18n";
import { getTerminalTheme, isLightTerminalTheme } from "../../lib/terminalThemes";
import { useSettingsStore } from "../../stores/settingsStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { MarkdownContent } from "../ui/MarkdownContent";
import { TERM } from "../stats/termStatsUi";

interface Props {
  sessionId: string;
  title?: string;
  /** 面板是否可见（与 XTermTerminal 同条件）；隐藏时不订阅 content、不解析、不滚动。 */
  isVisible: boolean;
}

interface TranscriptParseCache {
  sessionId: string;
  contentLen: number;
  resetSeq: number;
  nextId: number;
  omittedCount: number;
  cursor: SubagentTranscriptCursor;
  messages: SubagentTranscriptMessage[];
}

const TRANSCRIPT_PARSE_MAX_CHARS = 2 * 1024 * 1024;
const MAX_RENDERED_MESSAGES = 300;
const MAX_TOOL_DETAIL_CHARS = 64 * 1024;
const EMPTY_MESSAGES: SubagentTranscriptMessage[] = [];
const MIN_SUBAGENT_SCROLLBAR_THUMB = 24;

interface ScrollbarMetrics {
  visible: boolean;
  thumbHeight: number;
  thumbTop: number;
}

function parseTranscript(content: string, agentId?: string) {
  const parseContent = content.length > TRANSCRIPT_PARSE_MAX_CHARS
    ? content.slice(-TRANSCRIPT_PARSE_MAX_CHARS)
    : content;
  if (parseContent.length !== content.length) {
    debugConsoleWarn("[oom-diagnostics:webview]", {
      area: "subagentTranscript", phase: "parseTailOnly",
      contentChars: content.length, parsedChars: parseContent.length,
      droppedChars: content.length - parseContent.length, thresholdExceeded: true,
    });
  }
  const parsed = parseSubagentTranscript(parseContent, 1, undefined, agentId);
  return { ...parsed, messages: mergeSubagentMessages([], parsed.messages) };
}

function capRenderedMessages(messages: SubagentTranscriptMessage[]) {
  const overflow = Math.max(0, messages.length - MAX_RENDERED_MESSAGES);
  return { messages: overflow > 0 ? messages.slice(overflow) : messages, overflow };
}

interface TranscriptMessageRowProps {
  message: SubagentTranscriptMessage;
  terminalCodeTheme: "light" | "dark";
}

const TranscriptMessageRow = memo(function TranscriptMessageRow({ message, terminalCodeTheme }: TranscriptMessageRowProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(message.kind === "reasoning");
  const tool = message.kind === "tool" || message.kind === "tool-result";
  if (tool || message.kind === "reasoning") {
    const ToolIcon = /search|browse|web/i.test(message.toolName ?? "") ? Globe
      : /read|write|edit|file/i.test(message.toolName ?? "") ? FileText
        : /exec|shell|command|terminal/i.test(message.toolName ?? "") ? Terminal : Wrench;
    const completed = message.output !== undefined;
    const label = tool
      ? message.toolName?.split(".").pop() ?? t("subagentTranscript.toolResult")
      : t("subagentTranscript.reasoning");
    return (
      <li className="subagent-transcript-tool" data-failed={message.failed || undefined} data-reasoning={!tool || undefined}>
        <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
          <summary>
            <ChevronRight className="subagent-transcript-disclosure" size={12} aria-hidden="true" />
            {tool ? <ToolIcon size={13} aria-hidden="true" /> : <Brain size={13} aria-hidden="true" />}
            <span className="subagent-transcript-tool-name">{label}</span>
            {(tool || !expanded) && <span className="subagent-transcript-tool-summary">
              {tool ? subagentToolSummary(message) : message.text.replace(/\*\*([^*]+)\*\*/g, "$1").slice(0, 100)}
            </span>}
            {tool && <span className="subagent-transcript-tool-status" title={t(message.failed ? "subagentTranscript.toolFailed" : completed ? "subagentTranscript.toolCompleted" : "subagentTranscript.toolStarted")}>
              {message.failed ? <CircleX size={12} aria-hidden="true" /> : completed ? <Check size={12} aria-hidden="true" /> : <Circle size={9} aria-hidden="true" />}
            </span>}
          </summary>
          {expanded && <div className="subagent-transcript-tool-details">
            {message.arguments && <section>
              <h4>{t("subagentTranscript.arguments")}</h4>
              <pre>{message.arguments.slice(0, MAX_TOOL_DETAIL_CHARS)}</pre>
            </section>}
            {message.output !== undefined && <section>
              <h4>{t("subagentTranscript.output")}</h4>
              <pre>{message.output.slice(0, MAX_TOOL_DETAIL_CHARS) || t("subagentTranscript.noOutput")}</pre>
            </section>}
            {!tool && <MarkdownContent content={message.text.slice(0, MAX_TOOL_DETAIL_CHARS)} variant="terminal" compact
              terminalCodeTheme={terminalCodeTheme} className="subagent-transcript-markdown" />}
            {Math.max(message.arguments?.length ?? 0, message.output?.length ?? 0, message.text.length) > MAX_TOOL_DETAIL_CHARS
              && <p className="subagent-transcript-detail-limit">{t("subagentTranscript.detailLimit")}</p>}
          </div>}
        </details>
      </li>
    );
  }
  return (
    <li className="subagent-transcript-message" data-role={message.role}>
      <div className="subagent-transcript-role">
        <MessageSquare size={12} aria-hidden="true" />
        {t(message.role === "user" ? "subagentTranscript.task" : "subagentTranscript.reply")}
      </div>
      <MarkdownContent content={message.text} variant="terminal" compact
        terminalCodeTheme={terminalCodeTheme} className="subagent-transcript-markdown" />
    </li>
  );
});

const TranscriptActivityRow = memo(function TranscriptActivityRow({ activity, terminalCodeTheme }: {
  activity: SubagentTranscriptActivity;
  terminalCodeTheme: "light" | "dark";
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const counts = [
    activity.toolCount > 0 && t("subagentTranscript.activity.tools", { count: activity.toolCount }),
    activity.reasoningCount > 0 && t("subagentTranscript.activity.reasoning", { count: activity.reasoningCount }),
  ].filter(Boolean).join(" · ");
  const categories = activity.categories.map(category => t(`subagentTranscript.activity.${category}`));
  if (activity.pendingCount > 0) categories.push(t("subagentTranscript.activity.pending", { count: activity.pendingCount }));
  const preview = activity.latestReasoning?.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\s+/g, " ").slice(0, 240);
  return (
    <li className="subagent-transcript-activity">
      <details open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
        <summary>
          <ChevronRight className="subagent-transcript-disclosure" size={12} aria-hidden="true" />
          {activity.toolCount > 0 ? <Wrench size={13} aria-hidden="true" /> : <Brain size={13} aria-hidden="true" />}
          <span className="subagent-transcript-activity-heading">
            <span>{counts}</span>
            {categories.length > 0 && <small>{categories.join(" · ")}</small>}
          </span>
          {activity.failedCount > 0 && <span className="subagent-transcript-activity-failed">
            <CircleX size={11} aria-hidden="true" />{t("subagentTranscript.activity.failed", { count: activity.failedCount })}
          </span>}
        </summary>
        {expanded && <ul className="subagent-transcript-activity-details">
          {activity.messages.map(message => <TranscriptMessageRow key={message.id} message={message} terminalCodeTheme={terminalCodeTheme} />)}
        </ul>}
      </details>
      {!expanded && preview && <p className="subagent-transcript-reasoning-preview">
        <Brain size={12} aria-hidden="true" /><span>{preview}</span>
      </p>}
    </li>
  );
});

/**
 * 子 Agent 转录只读视图：渲染由后端 tail 推送、累积在 store 的转录内容。
 * 仅当用户停在底部时自动跟随滚动，避免打断向上翻阅。
 * 性能策略：resetSeq 不变时仅增量解析新增后缀；隐藏（isVisible=false）时不订阅
 * content 更新，直接渲染最近一次解析缓存，切回可见后一次性追平。
 */
export function SubagentTranscriptView({ sessionId, title, isVisible }: Props) {
  const { t } = useI18n();
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);
  const terminalThemeName = useSettingsStore((s) => s.terminalThemeName);
  const lightThemePalette = useSettingsStore((s) => s.lightThemePalette);
  const darkThemePalette = useSettingsStore((s) => s.darkThemePalette);
  const displayMode = useSettingsStore((s) => s.subagentTranscriptMode);
  const updateSetting = useSettingsStore((s) => s.update);
  // 隐藏时返回 undefined（稳定值）：转录追加不再触发本组件重渲染。
  const transcript = useTerminalStore((s) => (isVisible ? s.subagentTranscripts[sessionId] : undefined));
  // header 状态用独立原始值 selector 订阅，隐藏时也保持正确。
  const ended = useTerminalStore((s) => s.subagentTranscripts[sessionId]?.ended ?? false);
  const sourceKind = useTerminalStore((s) => s.subagentTranscripts[sessionId]?.source.kind);
  const status = useTerminalStore((s) => s.subagentTranscripts[sessionId]?.status);
  const nickname = useTerminalStore((s) => s.subagentTranscripts[sessionId]?.lifecycle?.nickname);
  const agentId = useTerminalStore((s) => s.sessions.find((session) => session.id === sessionId)?.subagent?.agentId);
  const parentId = useTerminalStore((s) => s.sessions.find((session) => session.id === sessionId)?.subagent?.parentSessionId);
  const parentTitle = useTerminalStore((s) => s.sessions.find((session) => session.id === parentId)?.title);
  const parentStatus = useTerminalStore((s) => parentId ? s.tabStatuses[parentId]?.hook : undefined);
  const displayStatus = status ?? (ended ? "completed" : sourceKind === "pending" ? "pending" : "unknown");
  const parentStopped = !ended && (parentStatus === "done" || parentStatus === "failed");

  const parseCacheRef = useRef<TranscriptParseCache | null>(null);
  const [parseSnapshot, setParseSnapshot] = useState<TranscriptParseCache | null>(null);

  useEffect(() => {
    if (!isVisible || !transcript) return;

    const { content, resetSeq } = transcript;
    const cache = parseCacheRef.current;
    let nextCache: TranscriptParseCache | null = null;

    if (!cache || cache.sessionId !== sessionId || cache.resetSeq !== resetSeq || content.length < cache.contentLen) {
      // reset / 前部裁剪 / 首次解析：走全量路径（保留 2MB 上限与诊断日志）。
      const parsed = parseTranscript(content, agentId);
      const capped = capRenderedMessages(parsed.messages);
      nextCache = {
        sessionId,
        contentLen: content.length,
        resetSeq,
        nextId: parsed.nextId,
        cursor: parsed.cursor,
        omittedCount: capped.overflow,
        messages: capped.messages,
      };
    } else if (content.length > cache.contentLen) {
      // 纯尾部追加：仅解析新增部分（Rust tail 保证推送为完整行），id 续号。
      const appended = parseSubagentTranscript(content.slice(cache.contentLen), cache.nextId, cache.cursor, agentId);
      const merged = mergeSubagentMessages(cache.messages, appended.messages);
      const capped = capRenderedMessages(merged);
      nextCache = {
        sessionId,
        contentLen: content.length,
        resetSeq,
        nextId: appended.nextId,
        cursor: appended.cursor,
        omittedCount: cache.omittedCount + capped.overflow,
        messages: capped.messages,
      };
    }

    if (!nextCache) return;
    parseCacheRef.current = nextCache;
    setParseSnapshot(nextCache);
  }, [agentId, isVisible, sessionId, transcript]);

  const messages = parseSnapshot?.sessionId === sessionId ? parseSnapshot.messages : EMPTY_MESSAGES;
  const omittedCount = parseSnapshot?.omittedCount ?? 0;
  const rows = useMemo(() => buildSubagentTranscriptRows(messages, displayMode), [displayMode, messages]);
  const hasReasoning = messages.some(message => message.kind === "reasoning");

  const terminalCodeTheme = useMemo<"light" | "dark">(() => {
    const terminalTheme = getTerminalTheme(
      terminalThemeName,
      resolvedTheme,
      lightThemePalette,
      darkThemePalette
    );
    return isLightTerminalTheme(terminalTheme) ? "light" : "dark";
  }, [darkThemePalette, lightThemePalette, resolvedTheme, terminalThemeName]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const scrollbarTrackRef = useRef<HTMLDivElement>(null);
  const scrollbarThumbRef = useRef<HTMLDivElement>(null);
  const scrollbarDragRef = useRef<{ pointerId: number; startY: number; startScrollTop: number } | null>(null);
  const [scrollbarDragging, setScrollbarDragging] = useState(false);
  const [scrollbarVisible, setScrollbarVisible] = useState(false);
  const scrollbarMetricsRef = useRef<ScrollbarMetrics>({ visible: false, thumbHeight: 0, thumbTop: 0 });
  const atBottomRef = useRef(true);

  const syncScrollbar = useCallback(() => {
    const scrollElement = scrollRef.current;
    const trackElement = scrollbarTrackRef.current;
    if (!scrollElement || !trackElement) return;

    const viewportHeight = scrollElement.clientHeight;
    const contentHeight = scrollElement.scrollHeight;
    const trackHeight = trackElement.clientHeight;
    const maxScrollTop = Math.max(0, contentHeight - viewportHeight);
    const visible = viewportHeight > 0 && trackHeight > 0 && maxScrollTop > 1;
    const thumbElement = scrollbarThumbRef.current;

    if (!visible) {
      scrollbarMetricsRef.current = { visible: false, thumbHeight: 0, thumbTop: 0 };
      if (thumbElement) {
        thumbElement.style.height = "0px";
        thumbElement.style.transform = "translateY(0px)";
      }
      setScrollbarVisible((current) => (current ? false : current));
      return;
    }

    const thumbHeight = Math.min(
      trackHeight,
      Math.max(MIN_SUBAGENT_SCROLLBAR_THUMB, Math.round(trackHeight * viewportHeight / contentHeight)),
    );
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    const thumbTop = maxScrollTop > 0
      ? Math.round((scrollElement.scrollTop / maxScrollTop) * maxThumbTop)
      : 0;

    scrollbarMetricsRef.current = { visible, thumbHeight, thumbTop };
    if (thumbElement) {
      thumbElement.style.height = `${thumbHeight}px`;
      thumbElement.style.transform = `translateY(${thumbTop}px)`;
    }
    setScrollbarVisible((current) => (current === visible ? current : visible));
  }, []);

  // 仅可见时跟随滚动；从隐藏切回可见且此前停在底部时补一次 scrollToBottom。
  useLayoutEffect(() => {
    if (!isVisible) return;
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
    syncScrollbar();
  }, [isVisible, rows, syncScrollbar]);

  useEffect(() => {
    const scrollElement = scrollRef.current;
    const contentElement = scrollContentRef.current;
    if (!scrollElement) return;

    const resizeObserver = new ResizeObserver(syncScrollbar);
    resizeObserver.observe(scrollElement);
    if (contentElement) resizeObserver.observe(contentElement);
    syncScrollbar();
    return () => resizeObserver.disconnect();
  }, [syncScrollbar]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    syncScrollbar();
  };

  const handleScrollbarPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const scrollElement = scrollRef.current;
    if (!scrollElement || !scrollbarMetricsRef.current.visible) return;
    event.preventDefault();
    event.stopPropagation();
    scrollbarDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: scrollElement.scrollTop,
    };
    setScrollbarDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleScrollbarPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = scrollbarDragRef.current;
    const scrollElement = scrollRef.current;
    const trackElement = scrollbarTrackRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !scrollElement || !trackElement) return;

    const maxScrollTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
    const maxThumbTop = Math.max(1, trackElement.clientHeight - scrollbarMetricsRef.current.thumbHeight);
    const nextScrollTop = drag.startScrollTop
      + ((event.clientY - drag.startY) / maxThumbTop) * maxScrollTop;
    scrollElement.scrollTop = Math.max(0, Math.min(maxScrollTop, nextScrollTop));
    syncScrollbar();
  };

  const handleScrollbarPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = scrollbarDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    scrollbarDragRef.current = null;
    setScrollbarDragging(false);
  };

  return (
    <div
      className="subagent-transcript-shell subagent-transcript-view flex h-full min-h-0 flex-col text-xs"
      style={{ backgroundColor: TERM.bg, color: TERM.fg }}
    >
      <header className="subagent-transcript-header">
        <GitBranch size={15} className="subagent-transcript-heading-icon" aria-hidden="true" />
        <div className="subagent-transcript-heading">
          <strong>{nickname ?? title ?? t("subagentTranscript.title")}</strong>
          <span>{t("subagentTranscript.readOnly")}{parentTitle ? ` · ${parentTitle}` : ""}</span>
        </div>
        <span className="subagent-transcript-status" data-status={displayStatus}>
          <i aria-hidden="true" />{t(`subagentTranscript.status.${displayStatus}`)}
        </span>
        <div className="subagent-transcript-mode" role="group" aria-label={t("subagentTranscript.mode.label")}>
          {(["summary", "full"] as const).map(mode => <button key={mode} type="button"
            aria-pressed={displayMode === mode} title={t(`subagentTranscript.mode.${mode}Hint`)}
            onClick={() => void updateSetting("subagentTranscriptMode", mode)}>
            {t(`subagentTranscript.mode.${mode}`)}
          </button>)}
        </div>
        {parentId && <button className="subagent-transcript-action" type="button"
          aria-label={t("subagentTranscript.backToParent")} title={t("subagentTranscript.backToParent")}
          onClick={() => useTerminalStore.getState().setActive(parentId)}>
          <ArrowUpLeft size={14} aria-hidden="true" />
        </button>}
        <button className="subagent-transcript-action" type="button"
          aria-label={t("subagentTranscript.latest")} title={t("subagentTranscript.latest")}
          onClick={() => { const el = scrollRef.current; if (el) { atBottomRef.current = true; el.scrollTop = el.scrollHeight; syncScrollbar(); } }}>
          <ArrowDown size={14} aria-hidden="true" />
        </button>
      </header>
      {parentStopped && <div className="subagent-transcript-notice" role="status">{t("subagentTranscript.parentStopped")}</div>}
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={handleScroll} className="ui-terminal-native-scroll h-full min-h-0 overflow-x-hidden overflow-y-auto subagent-transcript-scroll">
          <div ref={scrollContentRef}>
            {messages.length === 0 ? (
              <div className="subagent-transcript-empty">
                <GitBranch size={24} strokeWidth={1.25} aria-hidden="true" />
                <strong>{t(ended ? "subagentTranscript.emptyEnded" : "subagentTranscript.waiting")}</strong>
                <p>{t(sourceKind === "parent-jsonl" || sourceKind === "lifecycle-only"
                  ? "subagentTranscript.noIndependentOutput" : "subagentTranscript.waitingDescription")}</p>
              </div>
            ) : (
              <ul className="subagent-transcript-list">
                {omittedCount > 0 && (
                  <li className="py-1 text-center text-[10px]" style={{ color: TERM.dim }}>
                    {t("subagentTranscript.omittedMessages", { count: omittedCount })}
                  </li>
                )}
                {rows.map(row => row.kind === "activity"
                  ? <TranscriptActivityRow key={row.id} activity={row} terminalCodeTheme={terminalCodeTheme} />
                  : <TranscriptMessageRow key={row.id} message={row.message} terminalCodeTheme={terminalCodeTheme} />)}
              </ul>
            )}
          </div>
        </div>
        <div
          ref={scrollbarTrackRef}
          className="ui-subagent-scrollbar"
          data-visible={scrollbarVisible ? "true" : "false"}
          data-dragging={scrollbarDragging ? "true" : "false"}
          aria-hidden="true"
        >
          <div
            ref={scrollbarThumbRef}
            className="ui-subagent-scrollbar-thumb"
            onPointerDown={handleScrollbarPointerDown}
            onPointerMove={handleScrollbarPointerMove}
            onPointerUp={handleScrollbarPointerUp}
            onPointerCancel={handleScrollbarPointerUp}
          />
        </div>
      </div>
      <footer className="subagent-transcript-footer">
        <span>{t("subagentTranscript.executionHint")}</span>
        {messages.length > 0 && !hasReasoning && <span title={t("subagentTranscript.reasoningUnavailableHint")}>
          {t("subagentTranscript.reasoningUnavailable")}
        </span>}
      </footer>
    </div>
  );
}
