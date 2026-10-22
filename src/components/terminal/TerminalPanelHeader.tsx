import type { MouseEventHandler, ReactNode } from "react";
import { TERM_PANEL } from "../stats/termStatsUi";

interface TerminalPanelHeaderProps {
  className?: string;
  icon: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  subtitleTitle?: string;
  titleAccessory?: ReactNode;
  actions?: ReactNode;
  onTitleDoubleClick?: MouseEventHandler<HTMLDivElement>;
}

export function TerminalPanelHeader({
  className = "",
  icon,
  title,
  subtitle,
  subtitleTitle,
  titleAccessory,
  actions,
  onTitleDoubleClick,
}: TerminalPanelHeaderProps) {
  return (
    <header
      className={`ui-terminal-panel-header flex min-h-10 shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5 font-sans ${className}`}
      data-has-subtitle={subtitle ? "true" : undefined}
      style={{ backgroundColor: TERM_PANEL.bg }}
    >
      <div className="ui-terminal-panel-heading flex min-w-0 flex-1 items-center gap-2" onDoubleClick={onTitleDoubleClick}>
        <span
          className="ui-terminal-panel-icon flex shrink-0 items-center justify-center"
          style={{ color: TERM_PANEL.dim }}
        >
          {icon}
        </span>
        <div className="ui-terminal-panel-copy min-w-0 flex-1">
          <div className="ui-terminal-panel-title-row flex min-w-0 items-center gap-1.5">
            <h2 className="ui-terminal-panel-title truncate font-medium" style={{ color: TERM_PANEL.fg }} title={typeof title === "string" ? title : undefined}>
              {title}
            </h2>
            {titleAccessory}
          </div>
          {subtitle ? (
            <div className="ui-terminal-panel-subtitle truncate" style={{ color: TERM_PANEL.dim }} title={subtitleTitle ?? (typeof subtitle === "string" ? subtitle : undefined)}>
              {subtitle}
            </div>
          ) : null}
        </div>
      </div>
      {actions ? <div className="ui-terminal-panel-actions flex shrink-0 items-center gap-0.5">{actions}</div> : null}
    </header>
  );
}
