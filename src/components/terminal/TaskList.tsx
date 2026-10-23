import { useId, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";
import type { TaskDisplayStatus } from "../../lib/taskPresentation";
import { taskProgress } from "../../lib/taskPresentation";

export function TaskSection({ title, icon, count, scope, actions, children, busy, onBack, backLabel }: {
  title: string;
  icon?: ReactNode;
  count?: number;
  scope?: string;
  actions?: ReactNode;
  children: ReactNode;
  busy?: boolean;
  onBack?: () => void;
  backLabel?: string;
}) {
  const [userExpanded, setExpanded] = useState<boolean | null>(null);
  const expanded = userExpanded ?? (count === undefined || count > 0);
  const bodyId = useId();
  return <section className="task-section" aria-label={title} data-empty={count === 0 || undefined}>
    <header className="task-section__header">
      {onBack && <button type="button" className="task-action ui-focus-ring" onClick={onBack} aria-label={backLabel} title={backLabel}>
        <ArrowLeft size={13} aria-hidden="true" />
      </button>}
      <h3 className="task-section__heading">
        <button type="button" className="task-section__toggle ui-focus-ring" aria-label={count === undefined ? title : `${title} · ${busy ? "…" : count}`} aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded(!expanded)}>
          {icon && <span className="task-section__icon" aria-hidden="true">{icon}</span>}
          <span className="task-section__title">{title}</span>
          {count !== undefined && <span className="task-section__count">{busy ? "…" : count}</span>}
          <ChevronRight size={14} className="task-section__chevron" aria-hidden="true" />
        </button>
      </h3>
      {scope && <span className="task-section__scope" title={scope}>{scope}</span>}
      {actions && <div className="task-section__actions">{actions}</div>}
    </header>
    <div id={bodyId} className="task-section__body" hidden={!expanded} aria-busy={busy || undefined}>{children}</div>
  </section>;
}

export function TaskScopeHeader({ icon, title, subtitle, live }: { icon: ReactNode; title: string; subtitle: string; live?: boolean }) {
  return <header className="task-scope-header">
    <span className="task-scope-header__icon" aria-hidden="true">{icon}</span>
    <span className="task-scope-header__text">
      <h2 title={title}>{title}</h2>
      <span>{subtitle}</span>
    </span>
    {live !== undefined && <span className="task-scope-header__live" data-live={live || undefined} aria-hidden="true" />}
  </header>;
}

export function TaskStatus({ status, label }: { status?: TaskDisplayStatus; label: string }) {
  if (!status) return null;
  return <span className="task-status" data-status={status}><i aria-hidden="true" />{label}</span>;
}

export function TaskListItem({ title, titleHint, icon, metadata, status, actions, onOpen, selected, progress, children, alert }: {
  title: string;
  titleHint?: string;
  icon: ReactNode;
  metadata?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  onOpen?: () => void;
  selected?: boolean;
  progress?: number | null;
  children?: ReactNode;
  alert?: boolean;
}) {
  const content = <>
    <span className="task-row__title" title={titleHint || title}>{title}</span>
    {metadata && <span className="task-row__meta">{metadata}</span>}
  </>;
  const percentage = taskProgress(progress);
  return <div className="task-row" data-selected={selected || undefined} role={alert ? "alert" : undefined}>
    <span className="task-row__icon" aria-hidden="true">{icon}</span>
    {onOpen ? <button type="button" className="task-row__content task-row__open ui-focus-ring" onClick={onOpen} aria-label={title} aria-current={selected ? "true" : undefined}>{content}</button>
      : <div className="task-row__content">{content}</div>}
    <div className="task-row__trailing">
      {status}
      {actions && <div className="task-row__actions">{actions}</div>}
    </div>
    {progress !== undefined && <div className="task-row__progress" role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage ?? undefined} data-indeterminate={percentage === null || undefined}>
      <span style={{ width: percentage === null ? undefined : `${percentage}%` }} />
    </div>}
    {children && <div className="task-row__detail">{children}</div>}
  </div>;
}
