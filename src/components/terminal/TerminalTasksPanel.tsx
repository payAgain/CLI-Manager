import { useState } from "react";
import { ClipboardList, RefreshCw } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import type { Project, TerminalSession } from "../../lib/types";
import { BackgroundTasksPanel, type BackgroundTaskMeta } from "../BackgroundTasksPanel";
import { SubagentBrowserPanel } from "./SubagentBrowserPanel";
import { AgentTasksPanel } from "./AgentTasksPanel";
import { TerminalPanelHeader } from "./TerminalPanelHeader";

interface Props {
  session: TerminalSession | null;
  project?: Project | null;
  tasks: BackgroundTaskMeta[];
  onRefresh: () => Promise<void>;
  onRestored?: () => void;
}

export function TerminalTasksPanel({ session, project, tasks, onRefresh, onRestored }: Props) {
  const { t } = useI18n();
  const [refreshSeq, setRefreshSeq] = useState(0);

  return (
    <section className="ui-side-panel ui-tasks-sidebar flex h-full min-h-0 flex-col" aria-label={t("terminal.tasks.title")}>
      <TerminalPanelHeader
        icon={<ClipboardList size={16} strokeWidth={1.8} />}
        title={t("terminal.tasks.title")}
        actions={(
          <button type="button" className="ui-focus-ring ui-icon-action" aria-label={t("common.refresh")} title={t("common.refresh")} onClick={() => setRefreshSeq(seq => seq + 1)}>
            <RefreshCw size={13} />
          </button>
        )}
      />
      <div className="ui-side-panel-scroll ui-tasks-sidebar-content ui-thin-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="task-scope-group">
          <AgentTasksPanel key={session?.id ?? "none"} session={session} project={project} refreshSeq={refreshSeq} />
          <SubagentBrowserPanel session={session} project={project} refreshSeq={refreshSeq} />
        </div>
        <div className="task-scope-group task-scope-group--application">
          <header className="task-scope-heading"><h2>{t("terminal.agentTasks.applicationScope")}</h2><span>{t("terminal.agentTasks.applicationHint")}</span></header>
          <BackgroundTasksPanel tasks={tasks} onRefresh={onRefresh} onRestored={onRestored} refreshSeq={refreshSeq} />
        </div>
      </div>
    </section>
  );
}
