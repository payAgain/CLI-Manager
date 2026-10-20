import type { MouseEventHandler, ReactNode } from "react";
import { TERM_PANEL } from "../stats/termStatsUi";

interface TerminalPanelHeaderProps {
  icon: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  subtitleTitle?: string;
  titleAccessory?: ReactNode;
  actions?: ReactNode;
  onTitleDoubleClick?: MouseEventHandler<HTMLDivElement>;
}

export function TerminalPanelHeader({
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
      className="ui-terminal-panel-header flex min-h-10 shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5 font-sans"
      style={{ backgroundColor: TERM_PANEL.bg, borderColor: TERM_PANEL.border }}
    >
      <div className="flex min-w-0 items-center gap-2" onDoubleClick={onTitleDoubleClick}>
        <span
          className="flex shrink-0 items-center justify-center"
          style={{ color: TERM_PANEL.dim }}
        >
          {icon}
        </span>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[12px] font-medium leading-4" style={{ color: TERM_PANEL.fg }} title={typeof title === "string" ? title : undefined}>
              {title}
            </span>
            {titleAccessory}
          </div>
          {subtitle ? (
            <div className="truncate text-[10px] leading-3" style={{ color: TERM_PANEL.dim }} title={subtitleTitle}>
              {subtitle}
            </div>
          ) : null}
        </div>
      </div>
      {actions ? <div className="ui-terminal-panel-actions flex shrink-0 items-center gap-0.5">{actions}</div> : null}
    </header>
  );
}
