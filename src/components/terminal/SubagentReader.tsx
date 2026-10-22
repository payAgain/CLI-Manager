import { memo, useState } from "react";
import { Brain, Check, ChevronRight, Circle, CircleX, FileText, Globe, Terminal, Wrench } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { subagentTaskSummary } from "../../lib/subagentPresentation";
import { subagentToolCategory, subagentToolSummary, type SubagentReaderSection, type SubagentTranscriptActivity, type SubagentTranscriptMessage, type SubagentTranscriptMode, type SubagentToolCategory } from "../../lib/subagentTranscript";
import { MarkdownContent } from "../ui/MarkdownContent";

const MAX_DETAIL_CHARS = 64 * 1024;
type CodeTheme = "light" | "dark";
const toolIcons: Record<SubagentToolCategory, typeof Wrench> = {
  command: Terminal, read: FileText, edit: FileText, search: Globe, other: Wrench,
};

function preview(text: string) {
  return text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\s+/g, " ").trim();
}

const ReaderMessage = memo(function ReaderMessage({ message, codeTheme, anchor }: {
  message: SubagentTranscriptMessage; codeTheme: CodeTheme; anchor: string;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const toggleLabel = t(expanded ? "subagentTranscript.collapseMessage" : "subagentTranscript.expandMessage");
  return <div className="sr-message" id={anchor} data-message-id={message.id} data-expanded={expanded}>
    <button type="button" className="sr-fragment-toggle" aria-expanded={expanded} aria-controls={`${anchor}-body`}
      aria-label={toggleLabel} title={toggleLabel} onClick={() => setExpanded(value => !value)}>
      <ChevronRight size={12} aria-hidden="true" />
      {!expanded && <><span className="sr-fragment-preview">{preview(message.text)}</span><span className="sr-fragment-action">{toggleLabel}</span></>}
    </button>
    {expanded && <div id={`${anchor}-body`}>
      <MarkdownContent content={message.text} variant="terminal" terminalCodeTheme={codeTheme}
        className="subagent-transcript-markdown sr-markdown" />
    </div>}
  </div>;
});

const ReaderActivityItem = memo(function ReaderActivityItem({ message, codeTheme, mode, anchor }: {
  message: SubagentTranscriptMessage; codeTheme: CodeTheme; mode: SubagentTranscriptMode; anchor: string;
}) {
  const { t } = useI18n();
  const [manualExpanded, setManualExpanded] = useState<boolean>();
  const tool = message.kind === "tool" || message.kind === "tool-result";
  const expanded = manualExpanded ?? (mode === "full" && !tool);
  const ToolIcon = tool ? toolIcons[subagentToolCategory(message.toolName ?? "")] : Brain;
  const label = tool ? message.toolName?.split(".").pop() ?? t("subagentTranscript.toolResult") : t("subagentTranscript.reasoning");
  return <li className="sr-operation" id={anchor} data-message-id={message.id} data-expanded={expanded}
    data-kind={tool ? "tool" : "reasoning"} data-failed={message.failed || undefined}>
    <button type="button" className="sr-operation-toggle" aria-expanded={expanded} aria-controls={`${anchor}-body`}
      onClick={() => setManualExpanded(!expanded)}>
      <ChevronRight className="sr-disclosure" size={11} aria-hidden="true" />
      <ToolIcon size={13} aria-hidden="true" />
      <span className="sr-operation-name">{label}</span>
      <span className="sr-operation-preview">{tool ? subagentToolSummary(message) : preview(message.text)}</span>
      {tool && <span className="sr-operation-status" title={t(message.failed ? "subagentTranscript.toolFailed" : message.output !== undefined ? "subagentTranscript.toolCompleted" : "subagentTranscript.toolStarted")}>
        {message.failed ? <CircleX size={12} aria-hidden="true" /> : message.output !== undefined ? <Check size={12} aria-hidden="true" /> : <Circle size={8} aria-hidden="true" />}
      </span>}
    </button>
    {expanded && <div className="sr-operation-body" id={`${anchor}-body`}>
      {message.arguments && <section><h4>{t("subagentTranscript.arguments")}</h4><pre>{message.arguments.slice(0, MAX_DETAIL_CHARS)}</pre></section>}
      {message.output !== undefined && <section><h4>{t("subagentTranscript.output")}</h4><pre>{message.output.slice(0, MAX_DETAIL_CHARS) || t("subagentTranscript.noOutput")}</pre></section>}
      {!tool && <MarkdownContent content={message.text.slice(0, MAX_DETAIL_CHARS)} variant="terminal"
        terminalCodeTheme={codeTheme} className="subagent-transcript-markdown sr-markdown sr-reasoning" />}
      {Math.max(message.arguments?.length ?? 0, message.output?.length ?? 0, message.text.length) > MAX_DETAIL_CHARS
        && <p className="sr-detail-limit">{t("subagentTranscript.detailLimit")}</p>}
    </div>}
  </li>;
});

const ReaderActivity = memo(function ReaderActivity({ activity, codeTheme, mode, anchorPrefix }: {
  activity: SubagentTranscriptActivity; codeTheme: CodeTheme; mode: SubagentTranscriptMode; anchorPrefix: string;
}) {
  const { t } = useI18n();
  const [manualExpanded, setManualExpanded] = useState<boolean>();
  const expanded = manualExpanded ?? mode === "full";
  const counts = [
    activity.toolCount > 0 && t(activity.toolCount === 1 ? "subagentTranscript.activity.tool" : "subagentTranscript.activity.tools", { count: activity.toolCount }),
    activity.reasoningCount > 0 && t(activity.reasoningCount === 1 ? "subagentTranscript.activity.thought" : "subagentTranscript.activity.reasoning", { count: activity.reasoningCount }),
  ].filter(Boolean).join(" · ");
  const categories = activity.categories.map(category => t(`subagentTranscript.activity.${category}`)).join(" · ");
  const tools = activity.messages.filter(message => message.kind === "tool" || message.kind === "tool-result");
  const latestTool = tools[tools.length - 1];
  const ToolIcon = latestTool ? toolIcons[subagentToolCategory(latestTool.toolName ?? "")] : Brain;
  const summary = latestTool ? subagentToolSummary(latestTool) : preview(activity.latestReasoning ?? "");
  const anchor = `${anchorPrefix}-activity-${activity.id}`;
  return <div className="sr-process" data-expanded={expanded}>
    <button type="button" className="sr-process-toggle" aria-expanded={expanded} aria-controls={anchor}
      onClick={() => setManualExpanded(!expanded)} title={[t("subagentTranscript.reader.process"), counts, categories, summary].filter(Boolean).join("\n")}>
      <ToolIcon size={14} aria-hidden="true" />
      <span className="sr-process-counts">{counts}</span>
      {summary && <span className="sr-process-preview">{summary}</span>}
      {activity.pendingCount > 0 && <span className="sr-process-pending">{t("subagentTranscript.activity.pending", { count: activity.pendingCount })}</span>}
      {activity.failedCount > 0 && <span className="sr-process-failed"><CircleX size={11} aria-hidden="true" />{t("subagentTranscript.activity.failed", { count: activity.failedCount })}</span>}
      <ChevronRight className="sr-disclosure" size={12} aria-hidden="true" />
    </button>
    <ul className="sr-process-body" id={anchor} hidden={!expanded}>
      {activity.messages.map(message => <ReaderActivityItem key={message.id} message={message} codeTheme={codeTheme} mode={mode}
        anchor={`${anchorPrefix}-message-${message.id}`} />)}
    </ul>
  </div>;
});

export const SubagentReaderSectionView = memo(function SubagentReaderSectionView({ section, codeTheme, mode, anchorPrefix }: {
  section: SubagentReaderSection; codeTheme: CodeTheme; mode: SubagentTranscriptMode; anchorPrefix: string;
}) {
  const { t } = useI18n();
  const task = section.kind === "task";
  const [manualExpanded, setManualExpanded] = useState<boolean>();
  const expanded = manualExpanded ?? (!task || mode === "full");
  const label = t(task ? "subagentTranscript.reader.task" : "subagentTranscript.reader.response");
  const toggleLabel = t(expanded ? "subagentTranscript.collapseMessage" : "subagentTranscript.expandMessage");
  const anchor = `${anchorPrefix}-section-${section.id}`;
  return <section className={task ? "sr-task" : "sr-response"} data-section-id={section.id} data-expanded={expanded}>
    <button type="button" className="sr-section-toggle" aria-expanded={expanded} aria-controls={anchor}
      onClick={() => setManualExpanded(!expanded)} title={toggleLabel}>
      <ChevronRight className="sr-disclosure" size={12} aria-hidden="true" />
      <span className="sr-section-label">{label}</span>
      {!expanded && task && <span className="sr-task-preview">{subagentTaskSummary(section.message.text) || preview(section.message.text)}</span>}
      <span className="sr-section-action">{toggleLabel}</span>
    </button>
    <div id={anchor} className="sr-section-body" hidden={!expanded}>
      {section.kind === "task" ? <div id={`${anchorPrefix}-message-${section.message.id}`} data-message-id={section.message.id}>
        <MarkdownContent content={section.message.text} variant="terminal" terminalCodeTheme={codeTheme}
          className="subagent-transcript-markdown sr-markdown sr-task-markdown" />
      </div> : section.parts.map(part => part.kind === "activity"
        ? <ReaderActivity key={`activity-${part.id}`} activity={part} codeTheme={codeTheme} mode={mode} anchorPrefix={anchorPrefix} />
        : <div className="sr-text-run" key={`text-${part.id}`}>{part.messages.map(message => <ReaderMessage key={message.id}
          message={message} codeTheme={codeTheme} anchor={`${anchorPrefix}-message-${message.id}`} />)}</div>)}
    </div>
  </section>;
});
