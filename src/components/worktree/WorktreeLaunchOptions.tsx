import { useI18n } from "../../lib/i18n";
import { projectTerminalLaunchLabel, resolveProjectStartupCommand } from "../../lib/projectStartupCommand";
import type { Project } from "../../lib/types";
import type { WorktreeLaunchMode } from "../../lib/worktreeLaunch";

export function WorktreeLaunchOptions({ project, value, onChange }: {
  project: Project;
  value: WorktreeLaunchMode;
  onChange: (value: WorktreeLaunchMode) => void;
}) {
  const { t } = useI18n();
  const modes: WorktreeLaunchMode[] = resolveProjectStartupCommand(project) ? ["agent", "shell", "none"] : ["shell", "none"];
  return <fieldset className="mt-4 space-y-2">
    <legend className="mb-2 text-xs text-text-muted">{t("worktree.launch.title")}</legend>
    {modes.map(mode => <label key={mode} className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-bg-tertiary">
      <input type="radio" name="worktree-launch" value={mode} checked={value === mode}
        onChange={() => onChange(mode)} className="mt-1 accent-[var(--color-accent)]" />
      <span className="min-w-0 text-sm">
        {t(mode === "agent" ? project.startup_cmd.trim() ? projectTerminalLaunchLabel(project) : "worktree.launch.agent" : `worktree.launch.${mode}`)}
        <span className="mt-0.5 block text-xs text-text-muted">{t(`worktree.launch.${mode}Hint`)}</span>
      </span>
    </label>)}
  </fieldset>;
}
