import { useEffect, useState } from "react";
import { Switch } from "@mantine/core";
import { useCommandHistoryStore } from "../stores/commandHistoryStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useI18n } from "../lib/i18n";
import { recentTemplateCommands } from "../lib/commandHistory";
import type { CommandHistoryEntry } from "../lib/types";
import { useAppConfirm } from "./ui/useAppConfirm";
import { toast } from "sonner";

interface Props {
  projectId: string | null;
  query?: string;
  onSelect: (command: string) => void;
}

export function RecentCommandTemplates({ projectId, query = "", onSelect }: Props) {
  const { t, language } = useI18n();
  const revision = useCommandHistoryStore((state) => state.revision);
  const enabled = useSettingsStore((state) => state.commandHistoryEnabled);
  const updateSettings = useSettingsStore((state) => state.update);
  const [result, setResult] = useState<{ projectId: string | null; entries: CommandHistoryEntry[] }>({ projectId, entries: [] });
  const entries = result.projectId === projectId ? result.entries : [];
  const contextChanged = result.projectId !== projectId;
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const { confirm, confirmDialog } = useAppConfirm();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    setResult({ projectId, entries: [] });
    void useCommandHistoryStore.getState().getRecent(projectId, 1000).then((result) => {
      if (!cancelled) setResult({ projectId, entries: result });
    }).catch(() => {
      if (!cancelled) setFailed(true);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [projectId, revision, retry]);

  const commands = recentTemplateCommands(entries, query);
  const clearHistory = async () => {
    if (!await confirm({ title: t("commandTemplate.recent.clear"), message: t(projectId ? "commandTemplate.recent.clearProjectConfirm" : "commandTemplate.recent.clearAllConfirm"), danger: true })) return;
    try {
      await useCommandHistoryStore.getState().cleanup(projectId ?? undefined);
    } catch {
      toast.error(t("commandTemplate.recent.failed"));
    }
  };

  return (
    <div className="ui-recent-commands">
      <div className="ui-recent-commands-heading">
        <Switch size="xs" label={t("commandTemplate.recent.record")} checked={enabled} onChange={(event) => {
          const checked = event.currentTarget.checked;
          void updateSettings("commandHistoryEnabled", checked).catch(() => toast.error(t("commandTemplate.recent.failed")));
        }} />
        <button type="button" className="ui-focus-ring" disabled={loading || contextChanged || entries.length === 0} onClick={() => void clearHistory()}>{t("commandTemplate.recent.clear")}</button>
      </div>
      <p className="ui-recent-commands-note">{t("commandTemplate.recent.description")}</p>
      <p className="ui-recent-commands-scope">{t(projectId ? "commandTemplate.recent.project" : "commandTemplate.recent.all")}</p>
      <div className="ui-recent-commands-list" aria-busy={loading || contextChanged}>
        {loading || contextChanged ? <p role="status">{t("common.loading")}</p> : failed ? (
          <div role="alert"><p>{t("commandTemplate.recent.failed")}</p><button type="button" className="ui-flat-action" onClick={() => setRetry((value) => value + 1)}>{t("commandTemplate.recent.retry")}</button></div>
        ) : commands.length === 0 ? <p>{t(query.trim() ? "commandTemplate.recent.noMatches" : "commandTemplate.recent.empty")}</p> : commands.map((entry) => (
          <button type="button" key={entry.id} className="ui-recent-command ui-focus-ring" onClick={() => onSelect(entry.command)} title={entry.command} aria-label={t("commandTemplate.recent.useCommand", { command: entry.command })}>
            <code>{entry.command}</code>
            <span>{new Date(Number(entry.executed_at)).toLocaleString(language, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}</span>
          </button>
        ))}
      </div>
      {confirmDialog}
    </div>
  );
}
