import { Bot, ChevronRight, FileText, ListChecks, TerminalSquare } from "lucide-react";
import { useAgentTasks } from "../../hooks/useAgentTasks";
import { resolveHistorySourceIconKey } from "../../lib/cliTools";
import { useI18n } from "../../lib/i18n";
import type { AgentBackgroundTaskRecord, AgentTaskStatus } from "../../lib/agentTasks";
import type { Project, TerminalSession } from "../../lib/types";
import { CliToolIcon } from "../CliToolIcon";
import { MarkdownContent } from "../ui/MarkdownContent";
import { TaskScopeHeader, TaskSection, TaskStatus } from "./TaskList";

export function AgentTasksPanel({ session, project, refreshSeq }: { session: TerminalSession | null; project?: Project | null; refreshSeq: number }) {
  const { t } = useI18n();
  const { snapshot, loading, error, hasIdentity, remote, source } = useAgentTasks(session, project, refreshSeq);
  const unavailable = remote ? "terminal.agentTasks.remoteUnsupported" : !hasIdentity ? "terminal.agentTasks.noIdentity" : error ? "terminal.agentTasks.error" : snapshot && !snapshot.supported ? "terminal.agentTasks.unsupported" : null;
  const empty = (key: "terminal.agentTasks.tasksEmpty" | "terminal.agentTasks.plansEmpty" | "terminal.agentTasks.backgroundEmpty") => <p className="task-list-empty">{t(key)}</p>;
  const iconKey = resolveHistorySourceIconKey(source);
  const statusLabel = (status: AgentTaskStatus) => t(`terminal.agentTasks.status.${status}`);
  const background = snapshot?.backgroundTasks ?? [];
  const active = background.filter(task => task.status !== "done" && task.status !== "failed");
  const finished = background.filter(task => task.status === "done" || task.status === "failed");
  const failed = finished.filter(task => task.status === "failed").length;
  const backgroundRow = (task: AgentBackgroundTaskRecord) => {
    const command = task.title;
    const title = task.description.trim() || command;
    return <details className="agent-task-record agent-task-command" key={task.id} data-status={task.status}>
      <summary>
        <ChevronRight size={12} className="agent-task-record__chevron" aria-hidden="true" />
        <span className="agent-task-record__text"><span className="agent-task-record__name" title={title}>{title}</span><span className="agent-task-record__preview" title={command}>{title === command ? task.id : command}</span></span>
        <TaskStatus status={task.status} label={statusLabel(task.status)} />
      </summary>
      <div className="agent-task-record__body">
        <div className="agent-task-record__id">{task.id}</div>
        <span className="agent-task-record__label">{t("terminal.agentTasks.command")}</span>
        <pre className="ui-thin-scroll">{command}</pre>
        {task.output && <><span className="agent-task-record__label">{t("terminal.agentTasks.output")}</span><pre className="ui-thin-scroll">{task.output}</pre></>}
      </div>
    </details>;
  };
  return <div className="agent-task-sections">
    <TaskScopeHeader icon={iconKey ? <CliToolIcon icon={iconKey} size={16} /> : <Bot size={16} strokeWidth={1.8} />}
      title={session?.title || t("terminal.agentTasks.currentSession")} subtitle={t("terminal.agentTasks.live")} live={!unavailable && Boolean(snapshot)} />
    {unavailable && <p className="task-scope-notice" role={error ? "alert" : "status"}>{t(unavailable)}</p>}
    {loading && !snapshot && !unavailable && <p className="task-scope-notice" role="status">{t("terminal.agentTasks.loading")}</p>}
    <TaskSection icon={<ListChecks size={15} />} title={t("terminal.agentTasks.tasks")} count={unavailable ? undefined : snapshot?.tasks.length ?? 0} busy={loading}>
      {snapshot?.tasks.length ? snapshot.tasks.map(task => <details className="agent-task-record" key={task.id} data-status={task.status}>
        <summary>
          <ChevronRight size={12} className="agent-task-record__chevron" aria-hidden="true" />
          <span className="agent-task-record__name" title={task.title}>{task.title}</span>
          <TaskStatus status={task.status} label={statusLabel(task.status)} />
        </summary>
        <div className="agent-task-record__body">
          <div className="agent-task-record__id">#{task.id}</div>
          {task.description && <p>{task.description}</p>}
          {task.detail && <p>{task.detail}</p>}
        </div>
      </details>) : !unavailable && empty("terminal.agentTasks.tasksEmpty")}
    </TaskSection>
    <TaskSection icon={<FileText size={15} />} title={t("terminal.agentTasks.plans")} count={unavailable ? undefined : snapshot?.plans.length ?? 0} busy={loading}>
      {snapshot?.plans.length ? snapshot.plans.map(plan => <details className="agent-task-record agent-task-plan" key={plan.id} data-status={plan.status}>
        <summary><ChevronRight size={12} className="agent-task-record__chevron" aria-hidden="true" /><span className="agent-task-record__name" title={plan.title}>{plan.title}</span><TaskStatus status={plan.status} label={statusLabel(plan.status)} /></summary>
        <div className="agent-task-record__body"><MarkdownContent content={plan.content} compact /></div>
      </details>) : !unavailable && empty("terminal.agentTasks.plansEmpty")}
    </TaskSection>
    <TaskSection icon={<TerminalSquare size={15} />} title={t("terminal.agentTasks.background")} count={unavailable ? undefined : background.length} busy={loading}>
      {active.map(backgroundRow)}
      {!!finished.length && <details className="agent-task-archive">
        <summary><ChevronRight size={12} aria-hidden="true" /><span>{t("terminal.agentTasks.finished", { count: finished.length })}</span>{failed > 0 && <span className="agent-task-archive__failed">{t("terminal.agentTasks.failedCount", { count: failed })}</span>}</summary>
        {finished.map(backgroundRow)}
      </details>}
      {!background.length && !unavailable && empty("terminal.agentTasks.backgroundEmpty")}
    </TaskSection>
    {error && <details className="agent-task-diagnostics"><summary>{t("terminal.agentTasks.diagnostics")}</summary><pre>{error}</pre></details>}
    {!!snapshot?.warnings.length && <details className="agent-task-diagnostics"><summary>{t("terminal.agentTasks.partial")}</summary><pre>{snapshot.warnings.join("\n")}</pre></details>}
  </div>;
}
