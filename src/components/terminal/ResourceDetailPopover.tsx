import type { ReactNode } from "react";
import { RefreshCw, X } from "lucide-react";
import { Close as PopoverClose } from "@radix-ui/react-popover";
import { useI18n } from "../../lib/i18n";
import { PopoverContent } from "../ui/popover";

interface ResourceDetailPopoverProps {
  resource: string;
  title: string;
  icon: ReactNode;
  value?: ReactNode;
  summary?: ReactNode;
  scope: string;
  time: string;
  refreshLabel: string;
  onRefresh: () => void;
  refreshing?: boolean;
  side?: "top" | "right";
  children: ReactNode;
}

/** All resource entries share one frame; only the detail body scrolls. */
export function ResourceDetailPopover({
  resource, title, icon, value, summary, scope, time, refreshLabel, onRefresh, refreshing = false, side = "top", children,
}: ResourceDetailPopoverProps) {
  const { t } = useI18n();
  return (
    <PopoverContent side={side} align="end" className="ui-memory-popover ui-resource-detail-popover"
      aria-label={title} data-resource-detail={resource} data-memory-popover={resource === "application" ? "true" : undefined}>
      <header className="ui-resource-detail-header">
        <span className="ui-resource-detail-icon" aria-hidden="true">{icon}</span>
        <h2>{title}</h2>
        <button type="button" className="ui-resource-detail-action ui-focus-ring" onClick={onRefresh}
          disabled={refreshing} aria-label={refreshLabel} title={refreshLabel}>
          <RefreshCw size={12} className={refreshing ? "animate-spin" : undefined} />
        </button>
        <PopoverClose asChild><button type="button" className="ui-resource-detail-action ui-focus-ring"
          aria-label={t("common.close")} title={t("common.close")}><X size={13} /></button></PopoverClose>
      </header>
      {(summary || value) && <div className="ui-resource-detail-summary">{summary ?? <><span className="ui-resource-detail-value">{value}</span><span className="ui-resource-detail-summary-scope">{scope}</span></>}</div>}
      <div className="ui-resource-detail-body ui-thin-scroll">{children}</div>
      <footer className="ui-resource-detail-footer">
        <span title={scope}>{scope}</span>
        <time>{time}</time>
      </footer>
    </PopoverContent>
  );
}
