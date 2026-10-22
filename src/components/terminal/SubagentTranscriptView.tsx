import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowDown, ArrowUpLeft, Copy, GitBranch, Info } from "lucide-react";
import { toast } from "sonner";
import { buildSubagentReaderSections, mergeSubagentMessages, parseSubagentTranscript, type SubagentReaderSection, type SubagentTranscriptCursor, type SubagentTranscriptMessage } from "../../lib/subagentTranscript";
import { debugConsoleWarn } from "../../lib/debugConsole";
import { resolveSubagentPresentation, subagentTaskSummary } from "../../lib/subagentPresentation";
import { copyTextToClipboard } from "../../lib/systemClipboard";
import { normalizeTerminalFontFamily } from "../../lib/terminalFontFamily";
import { useI18n } from "../../lib/i18n";
import { useSettingsStore } from "../../stores/settingsStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { SubagentReaderSectionView } from "./SubagentReader";
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

/**
 * 子 Agent 转录只读视图：渲染由后端 tail 推送、累积在 store 的转录内容。
 * 仅当用户停在底部时自动跟随滚动，避免打断向上翻阅。
 * 性能策略：resetSeq 不变时仅增量解析新增后缀；隐藏（isVisible=false）时不订阅
 * content 更新，直接渲染最近一次解析缓存，切回可见后一次性追平。
 */
export function SubagentTranscriptView({ sessionId, title, isVisible }: Props) {
  const { t } = useI18n();
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const displayMode = useSettingsStore((s) => s.subagentTranscriptMode);
  const updateSetting = useSettingsStore((s) => s.update);
  // 隐藏时返回 undefined（稳定值）：转录追加不再触发本组件重渲染。
  const transcript = useTerminalStore((s) => (isVisible ? s.subagentTranscripts[sessionId] : undefined));
  // header 状态用独立原始值 selector 订阅，隐藏时也保持正确。
  const ended = useTerminalStore((s) => s.subagentTranscripts[sessionId]?.ended ?? false);
  const sourceKind = useTerminalStore((s) => s.subagentTranscripts[sessionId]?.source.kind);
  const status = useTerminalStore((s) => s.subagentTranscripts[sessionId]?.status);
  const nickname = useTerminalStore((s) => s.subagentTranscripts[sessionId]?.lifecycle?.nickname);
  const session = useTerminalStore((s) => s.sessions.find((item) => item.id === sessionId));
  const agentId = useTerminalStore((s) => s.sessions.find((session) => session.id === sessionId)?.subagent?.agentId);
  const parentId = useTerminalStore((s) => s.sessions.find((session) => session.id === sessionId)?.subagent?.parentSessionId);
  const parentTitle = useTerminalStore((s) => s.sessions.find((session) => session.id === parentId)?.title);
  const parentStatus = useTerminalStore((s) => parentId ? s.tabStatuses[parentId]?.hook : undefined);
  const displayStatus = status ?? (ended ? "completed" : sourceKind === "pending" ? "pending" : "unknown");
  const parentStopped = !ended && (parentStatus === "done" || parentStatus === "failed");
  const [metadataSession, setMetadataSession] = useState<string | null>(null);
  const metadataExpanded = metadataSession === sessionId;
  const metadataId = `subagent-${sessionId}-metadata`;

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
  const readerSnapshotRef = useRef<{ sessionId: string; resetSeq: number | undefined; sections: SubagentReaderSection[] } | null>(null);
  const readerResetSeq = parseSnapshot?.sessionId === sessionId ? parseSnapshot.resetSeq : undefined;
  const rows = useMemo(() => {
    const previous = readerSnapshotRef.current;
    return buildSubagentReaderSections(messages,
      previous?.sessionId === sessionId && previous.resetSeq === readerResetSeq ? previous.sections : []);
  }, [messages, readerResetSeq, sessionId]);
  useLayoutEffect(() => {
    readerSnapshotRef.current = { sessionId, resetSeq: readerResetSeq, sections: rows };
  }, [readerResetSeq, rows, sessionId]);
  const hasReasoning = messages.some(message => message.kind === "reasoning");
  const presentation = resolveSubagentPresentation({
    agentId, session, nickname, recordTitle: session?.subagent?.generatedTitle === title ? undefined : title,
    taskSummary: messages.filter(message => message.kind === "message" && message.role === "user")
      .map(message => subagentTaskSummary(message.text)).find(Boolean),
    fallbackTitle: t("subagentTranscript.title"),
  });
  const copyId = async () => {
    if (!agentId) return;
    try {
      await copyTextToClipboard(agentId);
      toast.success(t("subagentTranscript.idCopied"));
    } catch {
      toast.error(t("subagentTranscript.copyIdFailed"));
    }
  };

  // This reader uses the app surface; a separately chosen terminal palette must
  // not make code unreadable when the app and terminal use different themes.
  const terminalCodeTheme = resolvedTheme === "light" ? "light" : "dark";
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
      data-layout="reader"
      style={{
        backgroundColor: TERM.bg,
        color: TERM.fg,
        "--sr-font-family": normalizeTerminalFontFamily(fontFamily),
        "--sr-font-size": `${fontSize}px`,
      } as CSSProperties}
    >
      <header className="subagent-transcript-header" aria-label={presentation.title}>
        <div className="sr-reader-heading">
          <strong title={presentation.title}>{presentation.title}</strong>
        </div>
        <div className="subagent-transcript-controls">
          <span className="subagent-transcript-status" data-status={displayStatus}
            title={t(`subagentTranscript.status.${displayStatus}`)} aria-label={t(`subagentTranscript.status.${displayStatus}`)}>
            <i aria-hidden="true" /><span>{t(`subagentTranscript.status.${displayStatus}`)}</span>
          </span>
          <div className="subagent-transcript-mode" role="group" aria-label={t("subagentTranscript.mode.label")}>
            {(["summary", "full"] as const).map(mode => <button key={mode} type="button"
              aria-pressed={displayMode === mode} title={t(`subagentTranscript.mode.${mode}Hint`)}
              onClick={() => void updateSetting("subagentTranscriptMode", mode)}>
              {t(`subagentTranscript.mode.${mode}`)}
            </button>)}
          </div>
          {parentId && parentTitle !== undefined && <button className="subagent-transcript-action" type="button"
            aria-label={t(ended ? "subagentTranscript.collapseToParent" : "subagentTranscript.backToParent")}
            title={t(ended ? "subagentTranscript.collapseToParent" : "subagentTranscript.backToParent")}
            onClick={() => {
              const store = useTerminalStore.getState();
              if (ended) store.collapseSubagentTranscript(sessionId, true);
              else store.setActive(parentId);
            }}>
            <ArrowUpLeft size={14} aria-hidden="true" />
          </button>}
          <button className="subagent-transcript-action" type="button"
            aria-label={t("subagentTranscript.latest")} title={t("subagentTranscript.latest")}
            onClick={() => { const el = scrollRef.current; if (el) { atBottomRef.current = true; el.scrollTop = el.scrollHeight; syncScrollbar(); } }}>
            <ArrowDown size={14} aria-hidden="true" />
          </button>
          <button className="subagent-transcript-action sr-metadata-toggle" type="button"
            aria-label={t("subagentTranscript.reader.details")} title={t("subagentTranscript.reader.details")}
            aria-expanded={metadataExpanded} aria-controls={metadataId}
            onClick={() => setMetadataSession(metadataExpanded ? null : sessionId)}>
            <Info size={13} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div id={metadataId} className="sr-reader-metadata" hidden={!metadataExpanded}>
        <strong>{presentation.title}</strong>
        {parentTitle && <p>{t("subagentTranscript.reader.parent", { title: parentTitle })}</p>}
        <div className="subagent-transcript-context">
          <span className="subagent-transcript-readonly"
            title={t(ended ? "subagentTranscript.resultRetained" : "subagentTranscript.executionHint")}>
            {t("subagentTranscript.readOnly")}
          </span>
          {agentId && <button type="button" className="ui-focus-ring subagent-transcript-id" onClick={() => void copyId()}
            aria-label={t("subagentTranscript.copyId")} title={`${t("subagentTranscript.copyId")} · ${agentId}`}>
            <span>{agentId}</span><Copy size={11} aria-hidden="true" />
          </button>}
        </div>
        {messages.length > 0 && !hasReasoning && <p title={t("subagentTranscript.reasoningUnavailableHint")}>
          {t("subagentTranscript.reasoningUnavailable")}
        </p>}
      </div>
      {parentStopped && <div className="subagent-transcript-notice" role="status">{t("subagentTranscript.parentStopped")}</div>}
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={handleScroll} className="ui-terminal-native-scroll h-full min-h-0 overflow-x-hidden overflow-y-auto subagent-transcript-scroll sr-scroll">
          <div ref={scrollContentRef}>
            {messages.length === 0 ? (
              <div className="subagent-transcript-empty">
                <GitBranch size={24} strokeWidth={1.25} aria-hidden="true" />
                <strong>{t(ended ? "subagentTranscript.emptyEnded" : "subagentTranscript.waiting")}</strong>
                <p>{t(sourceKind === "parent-jsonl" || sourceKind === "lifecycle-only"
                  ? "subagentTranscript.noIndependentOutput" : "subagentTranscript.waitingDescription")}</p>
              </div>
            ) : (
              <div className="sr-document">
                {omittedCount > 0 && (
                  <p className="sr-omitted" style={{ color: TERM.dim }}>
                    {t("subagentTranscript.omittedMessages", { count: omittedCount })}
                  </p>
                )}
                {rows.map(section => <SubagentReaderSectionView key={`${sessionId}:${section.kind}:${section.id}`}
                  section={section} codeTheme={terminalCodeTheme} mode={displayMode} anchorPrefix={`subagent-${sessionId}`} />)}
              </div>
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
    </div>
  );
}
