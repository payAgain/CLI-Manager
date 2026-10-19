import { Filter, FolderPlus, PanelLeftClose, PanelLeftOpen, Plus } from "../icons";
import { useI18n } from "../../lib/i18n";

export type ProjectListFilter = "all" | "open";

interface SidebarHeaderProps {
  collapsed: boolean;
  density: "compact" | "comfortable";
  projectFilter: ProjectListFilter;
  showProjectFilter: boolean;
  totalProjectCount: number;
  openProjectCount: number;
  onToggleCollapse: () => void;
  onProjectFilterChange: (filter: ProjectListFilter) => void;
  onCreateGroup: () => void;
  onCreateProject: () => void;
}

export function SidebarHeader({
  collapsed,
  density,
  projectFilter,
  showProjectFilter,
  totalProjectCount,
  openProjectCount,
  onToggleCollapse,
  onProjectFilterChange,
  onCreateGroup,
  onCreateProject,
}: SidebarHeaderProps) {
  const { t } = useI18n();
  return (
    <div className="ui-sidebar-header" data-collapsed={collapsed} data-density={density}>
      <div className="ui-sidebar-heading">
        {!collapsed && (
          <div className="ui-sidebar-heading-label">
            <span>{t("sidebar.projects")}</span>
            <span className="ui-sidebar-project-count">{totalProjectCount}</span>
          </div>
        )}
        <div className="ui-sidebar-header-actions">
          <button type="button" className="ui-sidebar-tool ui-focus-ring" onClick={onToggleCollapse}
            title={t(collapsed ? "sidebar.expand" : "sidebar.collapse")}
            aria-label={t(collapsed ? "sidebar.expand" : "sidebar.collapse")}>
            {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
          </button>
          <button type="button" className="ui-sidebar-tool ui-focus-ring" onClick={onCreateGroup}
            title={t("sidebar.newGroup")} aria-label={t("sidebar.newGroup")}>
            <FolderPlus size={15} />
          </button>
          <button type="button" className="ui-sidebar-tool ui-focus-ring" onClick={onCreateProject}
            title={t("sidebar.addProject")} aria-label={t("sidebar.addProject")}>
            <Plus size={16} />
          </button>
          {collapsed && showProjectFilter && (
            <button type="button" className="ui-sidebar-tool ui-focus-ring"
              onClick={() => onProjectFilterChange(projectFilter === "open" ? "all" : "open")}
              title={t(projectFilter === "open" ? "sidebar.filter.showAll" : "sidebar.filter.showOpen")}
              aria-label={t(projectFilter === "open" ? "sidebar.filter.showAll" : "sidebar.filter.showOpen")}
              aria-pressed={projectFilter === "open"}>
              <Filter size={14} />
            </button>
          )}
        </div>
      </div>
      {!collapsed && showProjectFilter && (
        <div className="ui-sidebar-project-filters" role="group" aria-label={t("sidebar.projects")}>
          {(["all", "open"] as const).map((filter) => (
            <button key={filter} type="button" className="ui-sidebar-project-filter ui-focus-ring"
              aria-pressed={projectFilter === filter} onClick={() => onProjectFilterChange(filter)}>
              {t(filter === "all" ? "sidebar.filter.all" : "sidebar.filter.open", {
                count: filter === "all" ? totalProjectCount : openProjectCount,
              })}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
