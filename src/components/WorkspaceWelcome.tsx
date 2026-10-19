import { History, Plus, Terminal } from "lucide-react";
import { useI18n } from "../lib/i18n";

interface WorkspaceWelcomeProps {
  onOpenTerminal: () => void;
  onOpenHistory: () => void;
}

export function WorkspaceWelcome({ onOpenTerminal, onOpenHistory }: WorkspaceWelcomeProps) {
  const { t } = useI18n();
  return (
    <section className="ui-workspace-welcome">
      <Terminal size={30} strokeWidth={1.35} className="ui-welcome-mark" aria-hidden="true" />
      <h1>{t("workspace.welcome.title")}</h1>
      <p>{t("workspace.welcome.description")}</p>
      <div className="ui-welcome-actions">
        <button type="button" className="ui-btn ui-btn-primary ui-focus-ring" onClick={onOpenTerminal}>
          <Plus size={15} strokeWidth={1.7} aria-hidden="true" />
          {t("terminal.empty.action")}
        </button>
        <button type="button" className="ui-btn ui-btn-ghost ui-focus-ring" onClick={onOpenHistory}>
          <History size={15} strokeWidth={1.7} aria-hidden="true" />
          {t("workspace.welcome.history")}
        </button>
      </div>
    </section>
  );
}
