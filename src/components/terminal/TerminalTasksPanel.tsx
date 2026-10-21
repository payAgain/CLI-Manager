import { useState } from "react";
import { Layers, RefreshCw } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import type { Project, TerminalSession } from "../../lib/types";
import { BackgroundTasksPanel, type BackgroundTaskMeta } from "../BackgroundTasksPanel";
import { SubagentBrowserPanel } from "./SubagentBrowserPanel";

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
    <section className="flex h-full min-h-0 flex-col" aria-label={t("terminal.tasks.title")}>
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Layers size={14} />
        <h2 className="flex-1 text-xs font-medium">{t("terminal.tasks.title")}</h2>
        <button className="ui-focus-ring ui-icon-action" aria-label={t("common.refresh")} onClick={() => setRefreshSeq(seq => seq + 1)}>
          <RefreshCw size={13} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SubagentBrowserPanel session={session} project={project} refreshSeq={refreshSeq} />
        <BackgroundTasksPanel tasks={tasks} onRefresh={onRefresh} onRestored={onRestored} refreshSeq={refreshSeq} />
      </div>
    </section>
  );
}
