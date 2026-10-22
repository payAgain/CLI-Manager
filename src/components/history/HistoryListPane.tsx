import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowRightLeft, Bot, Check, ChevronDown, ChevronRight, Folder, ListChecks, MessageSquare, RefreshCw, Search, Star, Terminal, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
import type { Group, HistoryIndexStatus, HistorySearchHit, HistorySessionView, HistorySourceFilter, Project } from "../../lib/types";
import { useI18n } from "../../lib/i18n";
import { HISTORY_SOURCE_DESCRIPTOR_BY_ID, type HistorySourceId } from "../../lib/historySources";
import { resolveCliToolIconKey, resolveHistorySourceIconKey } from "../../lib/cliTools";
import { findWorktreeByPath } from "../../lib/terminalProject";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { CliToolIcon } from "../CliToolIcon";
import { Portal } from "../ui/Portal";
import { formatTime } from "./historyViewUtils";
import { buildHistorySessionHierarchy, buildHistorySessionTreeRows, inferSubagentParentSessionId, type HistorySessionTreeRow } from "../../lib/historySubagents";
import type { HistoryAgentGroup } from "../../lib/historyAgentGroups";

type HistoryListRow =
  | { type: "loading"; id: string }
  | { type: "searching"; id: string }
  | { type: "searchHeader"; id: string; count: number }
  | { type: "searchHit"; id: string; hit: HistorySearchHit }
  | { type: "group"; id: string; source: string; count: number; subagentCount: number }
  | HistorySessionTreeRow
  | { type: "empty"; id: string }
  | { type: "loadMore"; id: string };

type SessionContextMenu = {
  session: HistorySessionView;
  x: number;
  y: number;
};

type HistoryProjectTreeNode =
  | { type: "group"; group: Group; children: HistoryProjectTreeNode[] }
  | { type: "project"; project: Project };

function historyProjectPath(project: Project): string {
  return project.environment_type === "ssh" ? project.remote_path : project.path;
}

interface HistoryListPaneProps {
  historySidebarWidth: number;
  sidebarRef: RefObject<HTMLElement | null>;
  sessionListRef: RefObject<HTMLDivElement | null>;
  sourceFilter: HistorySourceFilter;
  projectPathFilter: string | null;
  projectIdFilter: string | null;
  scopedProjectPathFilter: string | null;
  projects: Project[];
  groups: Group[];
  globalQuery: string;
  favoriteOnly: boolean;
  activeSessionKey: string | null;
  loadingSessions: boolean;
  loadingMoreSessions: boolean;
  searching: boolean;
  normalizedGlobal: string;
  groupedSessions: HistoryAgentGroup[];
  filteredSessionCount: number;
  hasMoreSessions: boolean;
  loadMoreSessionMode: "local" | "backend";
  visibleSessionCount: number;
  searchHits: HistorySearchHit[];
  indexStatus: HistoryIndexStatus;
  globalSearchRef: RefObject<HTMLInputElement | null>;
  selectionMode: boolean;
  selectedCount: number;
  allVisibleSelected: boolean;
  selectedSessionKeys: Set<string>;
  onRefresh: () => void;
  onClose: () => void;
  onProjectPathFilterChange: (value: string | null, projectId?: string | null) => void;
  onGlobalQueryChange: (value: string) => void;
  onFavoriteOnlyChange: (value: boolean) => void;
  onEnterSelectionMode: () => void;
  onCancelSelectionMode: () => void;
  onToggleSelectAllVisible: () => void;
  onToggleSessionSelection: (sessionKey: string) => void;
  onOpenSession: (sessionKey: string) => void;
  onResumeSession: (session: HistorySessionView) => void;
  canConvertSession: (session: HistorySessionView) => boolean;
  onConvertSession: (session: HistorySessionView) => void;
  onDeleteSession: (session: HistorySessionView) => void;
  onDeleteSelected: () => void;
  onOpenHit: (hit: HistorySearchHit) => void;
  onLoadMoreSessions: () => void;
  onSessionListScroll: () => void;
  onStartResize: (e: ReactMouseEvent) => void;
}

function formatSessionClock(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "-";
  const date = new Date(ts);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function rowHeight(row: HistoryListRow): number {
  if (row.type === "missingParent") return 38;
  if (row.type === "group") return 44;
  if (row.type === "searchHeader" || row.type === "searching") return 32;
  if (row.type === "empty") return 88;
  if (row.type === "loading" || row.type === "loadMore") return 56;
  if (row.type === "searchHit") return 72;
  return (row.depth > 0 ? 54 : 62) + (row.familyEnd ? 8 : 0);
}

function SelectionCheckbox({
  checked,
  title,
  ariaLabel,
  onToggle,
}: {
  checked: boolean;
  title: string;
  ariaLabel: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      title={title}
      aria-label={ariaLabel}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className="ui-focus-ring mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors"
      style={{
        borderColor: checked ? "var(--primary)" : "color-mix(in srgb, var(--border) 82%, transparent)",
        backgroundColor: checked ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent",
        color: checked ? "var(--primary)" : "var(--text-muted)",
      }}
    >
      {checked ? <Check size={12} strokeWidth={2.5} /> : null}
    </button>
  );
}

function buildHistoryProjectTree(groups: Group[], projects: Project[]): HistoryProjectTreeNode[] {
  const childGroups = new Map<string | null, Group[]>();
  const groupProjects = new Map<string | null, Project[]>();

  for (const group of groups) {
    const list = childGroups.get(group.parent_id) ?? [];
    list.push(group);
    childGroups.set(group.parent_id, list);
  }

  for (const project of projects) {
    const list = groupProjects.get(project.group_id) ?? [];
    list.push(project);
    groupProjects.set(project.group_id, list);
  }

  const buildLevel = (parentId: string | null): HistoryProjectTreeNode[] => {
    const nodes: HistoryProjectTreeNode[] = [];
    const sortedGroups = [...(childGroups.get(parentId) ?? [])].sort(
      (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)
    );
    const sortedProjects = [...(groupProjects.get(parentId) ?? [])].sort(
      (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)
    );

    for (const group of sortedGroups) {
      nodes.push({ type: "group", group, children: buildLevel(group.id) });
    }
    for (const project of sortedProjects) {
      nodes.push({ type: "project", project });
    }
    return nodes;
  };

  return buildLevel(null);
}

function countProjects(node: HistoryProjectTreeNode): number {
  if (node.type === "project") return 1;
  return node.children.reduce((sum, child) => sum + countProjects(child), 0);
}

function ProjectFilterIcon({ project, size = 13 }: { project: Project; size?: number }) {
  const icon = resolveCliToolIconKey(project.cli_tool);
  return icon ? <CliToolIcon icon={icon} size={size} /> : <Terminal size={size} strokeWidth={1.5} />;
}

function SessionSourceIcon({ source, size = 14 }: { source: string; size?: number }) {
  const icon = resolveHistorySourceIconKey(source);
  return icon ? <CliToolIcon icon={icon} size={size} /> : <Terminal size={size} strokeWidth={1.5} />;
}

function collectGroupIds(nodes: HistoryProjectTreeNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.type !== "group") continue;
    out.push(node.group.id);
    collectGroupIds(node.children, out);
  }
  return out;
}

/** 找到选中项目的祖先分组 id，用于展开父节点。 */
function findAncestorGroupIds(
  nodes: HistoryProjectTreeNode[],
  match: (project: Project) => boolean,
  trail: string[] = [],
): string[] | null {
  for (const node of nodes) {
    if (node.type === "project") {
      if (match(node.project)) return trail;
      continue;
    }
    const found = findAncestorGroupIds(node.children, match, [...trail, node.group.id]);
    if (found) return found;
  }
  return null;
}

function normalizeProjectSearch(value: string): string {
  return value.trim().toLowerCase();
}

const IMAGE_TITLE_TOKEN_PATTERN = /<image\b[^>\r\n]*(?:>|$)|\[Image #\d+\]/gi;
const IMAGE_CLOSE_TOKEN_PATTERN = /<\/image>/gi;

function formatSessionListTitle(title: string, imageLabel: string): string {
  const normalizedTitle = title.replace(IMAGE_CLOSE_TOKEN_PATTERN, " ");
  const imageTokens = normalizedTitle.match(IMAGE_TITLE_TOKEN_PATTERN);
  if (!imageTokens || imageTokens.length === 0) return title;

  const onlyImages = normalizedTitle.replace(IMAGE_TITLE_TOKEN_PATTERN, "").trim().length === 0;
  let index = 0;
  const replacement = () => {
    index += 1;
    return `[${imageTokens.length === 1 ? imageLabel : `${imageLabel}${index}`}]`;
  };

  if (onlyImages) {
    return imageTokens.map(replacement).join("");
  }
  return normalizedTitle.replace(IMAGE_TITLE_TOKEN_PATTERN, replacement).replace(/\s+/g, " ").trim();
}

function projectMatchesSearch(project: Project, query: string): boolean {
  if (!query) return true;
  return (
    project.name.toLowerCase().includes(query) ||
    project.path.toLowerCase().includes(query) ||
    project.cli_tool.toLowerCase().includes(query)
  );
}

function filterHistoryProjectTree(nodes: HistoryProjectTreeNode[], query: string): HistoryProjectTreeNode[] {
  if (!query) return nodes;

  const result: HistoryProjectTreeNode[] = [];
  for (const node of nodes) {
    if (node.type === "project") {
      if (projectMatchesSearch(node.project, query)) result.push(node);
      continue;
    }

    const groupMatches = node.group.name.toLowerCase().includes(query);
    const children = groupMatches
      ? node.children
      : filterHistoryProjectTree(node.children, query);
    if (groupMatches || children.length > 0) {
      result.push({ ...node, children });
    }
  }
  return result;
}

export function HistoryListPane({
  historySidebarWidth,
  sidebarRef,
  sessionListRef,
  sourceFilter,
  projectPathFilter,
  projectIdFilter,
  scopedProjectPathFilter,
  projects,
  groups,
  globalQuery,
  favoriteOnly,
  activeSessionKey,
  loadingSessions,
  loadingMoreSessions,
  searching,
  normalizedGlobal,
  groupedSessions,
  filteredSessionCount,
  hasMoreSessions,
  loadMoreSessionMode,
  visibleSessionCount,
  searchHits,
  indexStatus,
  globalSearchRef,
  selectionMode,
  selectedCount,
  allVisibleSelected,
  selectedSessionKeys,
  onRefresh,
  onClose,
  onProjectPathFilterChange,
  onGlobalQueryChange,
  onFavoriteOnlyChange,
  onEnterSelectionMode,
  onCancelSelectionMode,
  onToggleSelectAllVisible,
  onToggleSessionSelection,
  onOpenSession,
  onResumeSession,
  canConvertSession,
  onConvertSession,
  onDeleteSession,
  onDeleteSelected,
  onOpenHit,
  onLoadMoreSessions,
  onSessionListScroll,
  onStartResize,
}: HistoryListPaneProps) {
  const { t, language } = useI18n();
  const [contextMenu, setContextMenu] = useState<SessionContextMenu | null>(null);
  const [collapsedFilterGroups, setCollapsedFilterGroups] = useState<Set<string>>(new Set());
  const [expandedSessionParents, setExpandedSessionParents] = useState<Set<string>>(new Set());
  const [collapsedAgents, setCollapsedAgents] = useState<Set<string>>(new Set());
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [projectSearchQuery, setProjectSearchQuery] = useState("");
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const projectDropdownRef = useRef<HTMLDivElement | null>(null);
  const projectTreeScrollRef = useRef<HTMLDivElement | null>(null);
  const selectedProjectNodeRef = useRef<HTMLButtonElement | null>(null);
  const projectMenuWasOpenRef = useRef(false);
  const worktrees = useWorktreeStore((state) => state.worktrees);
  const globalQueryLength = [...globalQuery.trim()].length;
  useEffect(() => {
    const ancestors = new Set<string>();
    for (const group of groupedSessions) {
      const { parentByChildKey } = buildHistorySessionHierarchy(group.items);
      if (normalizedGlobal || favoriteOnly) {
        for (const parent of parentByChildKey.values()) ancestors.add(parent.sessionKey);
      }
      let parent = activeSessionKey ? parentByChildKey.get(activeSessionKey) : undefined;
      while (parent && !ancestors.has(parent.sessionKey)) {
        ancestors.add(parent.sessionKey);
        parent = parentByChildKey.get(parent.sessionKey);
      }
    }
    if (ancestors.size) setExpandedSessionParents((previous) => {
      if ([...ancestors].every((key) => previous.has(key))) return previous;
      return new Set([...previous, ...ancestors]);
    });
  }, [activeSessionKey, favoriteOnly, groupedSessions, normalizedGlobal]);
  const globalQueryTooShort = globalQueryLength > 0 && globalQueryLength < 3;
  const indexBusy = ["seeding", "scanning", "indexing"].includes(indexStatus.phase);
  const projectTree = useMemo(() => buildHistoryProjectTree(groups, projects), [groups, projects]);
  const selectedProject = useMemo(() => {
    if (projectIdFilter) {
      return projects.find((project) => project.id === projectIdFilter) ?? null;
    }
    if (!projectPathFilter) return null;
    return projects.find((project) => historyProjectPath(project) === projectPathFilter) ?? null;
  }, [projectIdFilter, projectPathFilter, projects]);
  const selectedWorktree = useMemo(
    () => findWorktreeByPath(worktrees, scopedProjectPathFilter ?? projectPathFilter),
    [projectPathFilter, scopedProjectPathFilter, worktrees]
  );
  const getSessionWorktree = useCallback(
    (session: HistorySessionView) => findWorktreeByPath(worktrees, session.cwd) ?? selectedWorktree,
    [selectedWorktree, worktrees]
  );
  const projectGroupIds = useMemo(() => collectGroupIds(projectTree), [projectTree]);
  const normalizedProjectSearch = useMemo(() => normalizeProjectSearch(projectSearchQuery), [projectSearchQuery]);
  const filteredProjectTree = useMemo(
    () => filterHistoryProjectTree(projectTree, normalizedProjectSearch),
    [normalizedProjectSearch, projectTree]
  );
  const filteredProjectCount = useMemo(
    () => filteredProjectTree.reduce((sum, node) => sum + countProjects(node), 0),
    [filteredProjectTree]
  );
  const selectedProjectLabel = useMemo(() => {
    if (selectedProject) return selectedProject.name;
    if (!projectPathFilter) return t("history.allProjects");
    return projectPathFilter.split(/[\\/]/).pop() || projectPathFilter;
  }, [projectPathFilter, selectedProject, t]);
  const selectedProjectMatch = useCallback((project: Project) => {
    if (projectIdFilter) return project.id === projectIdFilter;
    if (!projectPathFilter) return false;
    return historyProjectPath(project) === projectPathFilter;
  }, [projectIdFilter, projectPathFilter]);
  const selectedAncestorGroupIds = useMemo(() => {
    if (!projectPathFilter && !projectIdFilter) return [] as string[];
    return findAncestorGroupIds(projectTree, selectedProjectMatch) ?? [];
  }, [projectIdFilter, projectPathFilter, projectTree, selectedProjectMatch]);

  const emptySessionCopy = useMemo(() => {
    const sourceDescriptor = sourceFilter === "all" ? null : HISTORY_SOURCE_DESCRIPTOR_BY_ID.get(sourceFilter);
    const sourceLabel = sourceDescriptor ? t(sourceDescriptor.labelKey) : t("common.allSources");
    if (normalizedGlobal) {
      return {
        title: t("history.empty.noMatchesTitle"),
        description: t("history.empty.noMatchesDescription"),
      };
    }
    if (favoriteOnly) {
      return {
        title: t("history.empty.noFavoritesTitle"),
        description: t("history.empty.noFavoritesDescription"),
      };
    }
    if (projectPathFilter) {
      return {
        title: t("history.empty.noHistoryTitle"),
        description: t("history.empty.projectNoSessions", { project: selectedProjectLabel, source: sourceLabel }),
      };
    }
    return {
      title: t("history.empty.noHistoryTitle"),
      description: t("history.empty.sourceNoSessions", { source: sourceLabel }),
    };
  }, [favoriteOnly, normalizedGlobal, projectPathFilter, selectedProjectLabel, sourceFilter, t]);

  const toggleFilterGroup = useCallback((groupId: string) => {
    setCollapsedFilterGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  const toggleSessionParent = useCallback((sessionKey: string) => {
    setExpandedSessionParents((prev) => {
      const next = new Set(prev);
      if (next.has(sessionKey)) next.delete(sessionKey);
      else next.add(sessionKey);
      return next;
    });
  }, []);

  const toggleAgent = useCallback((source: string) => {
    setCollapsedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });
  }, []);

  const handleProjectFilterChange = useCallback(
    (projectPath: string | null, projectId?: string | null) => {
      onProjectPathFilterChange(projectPath, projectId);
      setProjectMenuOpen(false);
    },
    [onProjectPathFilterChange]
  );

  const handleSessionContextMenu = useCallback((e: ReactMouseEvent, session: HistorySessionView) => {
    e.preventDefault();
    setContextMenu({ session, x: e.clientX, y: e.clientY });
  }, []);

  const handleContextMenuDelete = useCallback(() => {
    if (!contextMenu) return;
    const session = contextMenu.session;
    setContextMenu(null);
    onDeleteSession(session);
  }, [contextMenu, onDeleteSession]);

  const handleContextMenuResume = useCallback(() => {
    if (!contextMenu) return;
    const session = contextMenu.session;
    setContextMenu(null);
    onResumeSession(session);
  }, [contextMenu, onResumeSession]);

  const handleContextMenuConvert = useCallback(() => {
    if (!contextMenu) return;
    const session = contextMenu.session;
    setContextMenu(null);
    onConvertSession(session);
  }, [contextMenu, onConvertSession]);

  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: Event) => {
      if (contextMenuRef.current && contextMenuRef.current.contains(e.target as Node)) return;
      setContextMenu(null);
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    window.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
      window.removeEventListener("keydown", keyHandler);
    };
  }, [contextMenu]);

  useEffect(() => {
    const wasOpen = projectMenuWasOpenRef.current;
    projectMenuWasOpenRef.current = projectMenuOpen;

    if (!projectMenuOpen) {
      setProjectSearchQuery("");
      return;
    }

    if (!wasOpen) {
      // 默认折叠全部，再展开选中项目的祖先链，方便一眼看到高亮项。
      const nextCollapsed = new Set(projectGroupIds);
      for (const groupId of selectedAncestorGroupIds) {
        nextCollapsed.delete(groupId);
      }
      setCollapsedFilterGroups(nextCollapsed);
    }
  }, [projectGroupIds, projectMenuOpen, selectedAncestorGroupIds]);

  useEffect(() => {
    if (!projectMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (projectDropdownRef.current?.contains(e.target as Node)) return;
      setProjectMenuOpen(false);
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setProjectMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    window.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      window.removeEventListener("keydown", keyHandler);
    };
  }, [projectMenuOpen]);

  useEffect(() => {
    if (!projectMenuOpen || normalizedProjectSearch) return;
    if (!projectPathFilter && !projectIdFilter) return;

    const frame = window.requestAnimationFrame(() => {
      const node = selectedProjectNodeRef.current;
      const scroller = projectTreeScrollRef.current;
      if (!node || !scroller) return;

      const nodeTop = node.offsetTop - scroller.offsetTop;
      const targetTop = nodeTop - Math.max(0, (scroller.clientHeight - node.offsetHeight) / 2);
      scroller.scrollTo({
        top: Math.max(0, targetTop),
        behavior: "auto",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [normalizedProjectSearch, projectIdFilter, projectMenuOpen, projectPathFilter, selectedAncestorGroupIds]);

  const rows = useMemo<HistoryListRow[]>(() => {
    if (loadingSessions) return [{ type: "loading", id: "loading" }];

    const next: HistoryListRow[] = [];
    if (normalizedGlobal && searching) {
      next.push({ type: "searching", id: "searching" });
    }
    if (normalizedGlobal && searchHits.length > 0) {
      next.push({ type: "searchHeader", id: "search-header", count: searchHits.length });
      searchHits.forEach((hit, index) => {
        next.push({ type: "searchHit", id: `hit:${hit.file_path}:${index}`, hit });
      });
    }

    for (const group of groupedSessions) {
      next.push({ type: "group", id: `agent:${group.source}`, source: group.source, count: group.items.filter((item) => !inferSubagentParentSessionId(item)).length,
        subagentCount: group.items.filter((item) => inferSubagentParentSessionId(item)).length });
      if (!collapsedAgents.has(group.source)) next.push(...buildHistorySessionTreeRows(group.items, expandedSessionParents));
    }

    if (filteredSessionCount === 0) {
      next.push({ type: "empty", id: "empty" });
    }
    if (hasMoreSessions) {
      next.push({ type: "loadMore", id: "load-more" });
    }
    return next;
  }, [collapsedAgents, expandedSessionParents, filteredSessionCount, groupedSessions, hasMoreSessions, loadingSessions, normalizedGlobal, searchHits, searching]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => sessionListRef.current,
    estimateSize: (index) => rowHeight(rows[index] ?? { type: "loading", id: "fallback" }),
    measureElement: (element) => element.getBoundingClientRect().height,
    overscan: 10,
    getItemKey: (index) => rows[index]?.id ?? index,
  });

  const menuX = contextMenu ? Math.max(8, Math.min(contextMenu.x, window.innerWidth - 200)) : 0;
  const menuY = contextMenu ? Math.max(8, Math.min(contextMenu.y, window.innerHeight - 80)) : 0;

  const renderProjectNode = (node: HistoryProjectTreeNode, depth = 0): ReactNode => {
    const paddingLeft = 8 + depth * 14;
    if (node.type === "group") {
      const isOpen = Boolean(normalizedProjectSearch) || !collapsedFilterGroups.has(node.group.id);
      return (
        <div key={`group:${node.group.id}`}>
          <button
            type="button"
            onClick={() => toggleFilterGroup(node.group.id)}
            className="ui-tree-node ui-tree-group ui-focus-ring flex h-7 w-full items-center gap-1.5 rounded-lg pr-2 text-left text-[11px] font-semibold"
            style={{ paddingLeft }}
            aria-expanded={isOpen}
          >
            <ChevronRight size={12} className="shrink-0" style={{ transform: isOpen ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 150ms" }} />
            <Folder size={13} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{node.group.name}</span>
            <span className="ui-tree-count-badge rounded-full px-1.5 text-[10px] font-medium">{countProjects(node)}</span>
          </button>
          {isOpen && node.children.length > 0 && (
            <div className="mt-0.5 space-y-0.5">
              {node.children.map((child) => renderProjectNode(child, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    const projectPath = historyProjectPath(node.project);
    const selected = selectedProjectMatch(node.project);
    return (
      <button
        key={`project:${node.project.id}`}
        ref={selected ? selectedProjectNodeRef : undefined}
        type="button"
        onClick={() => handleProjectFilterChange(
          selected ? null : projectPath,
          selected ? null : node.project.id,
        )}
        className="ui-tree-node ui-tree-project ui-focus-ring flex h-7 w-full items-center gap-1.5 rounded-lg pr-2 text-left text-[12px]"
        data-selected={selected ? "true" : "false"}
        style={{ paddingLeft }}
        title={projectPath}
      >
        <span className="ui-tree-leading-icon">
          <ProjectFilterIcon project={node.project} size={13} />
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{node.project.name}</span>
      </button>
    );
  };

  return (
    <aside
      ref={sidebarRef}
      className="ui-history-sidebar ui-history-sidebar-compact history-hierarchy relative flex min-h-0 min-w-[220px] max-w-[70%] flex-col"
      data-layout="family-tree"
      style={{ width: historySidebarWidth }}
    >
      <div className="ui-history-sidebar-top">
        <div className="ui-history-compact-heading">
          <span className="ui-history-compact-title">{t("workspace.historyNav")}</span>
          <button type="button" className="ui-flat-action ui-focus-ring ui-history-icon-button"
            onClick={() => onFavoriteOnlyChange(!favoriteOnly)} aria-pressed={favoriteOnly}
            aria-label={favoriteOnly ? t("history.favoriteFilter.showAll") : t("history.favoriteFilter.showOnly")}
            title={favoriteOnly ? t("history.favoriteFilter.showAll") : t("history.favoriteFilter.showOnly")}
            style={{ color: favoriteOnly ? "var(--warning)" : undefined }}>
            <Star size={12} fill={favoriteOnly ? "currentColor" : "none"} />
          </button>
          <button type="button" className="ui-flat-action ui-focus-ring ui-history-icon-button"
            onClick={selectionMode ? onCancelSelectionMode : onEnterSelectionMode}
            disabled={!selectionMode && filteredSessionCount === 0} aria-pressed={selectionMode}
            aria-label={t(selectionMode ? "history.bulk.cancelSelection" : "history.bulk.enterSelection")}
            title={t(selectionMode ? "history.bulk.cancelSelection" : "history.bulk.enterSelection")}>
            <ListChecks size={13} />
          </button>
          <button type="button" onClick={onRefresh} aria-label={t("history.refreshList")}
            className="ui-flat-action ui-focus-ring ui-history-icon-button ui-history-list-action" title={t("history.refreshList")}>
            <RefreshCw size={12} className={indexBusy ? "animate-spin" : undefined} />
          </button>
          <button type="button" onClick={onClose} aria-label={t("history.close")}
            className="ui-flat-action ui-focus-ring ui-history-icon-button ui-history-close-action" title={t("history.close")}>
            <X size={13} />
          </button>
        </div>
        <div className="ui-history-compact-filters">
          <div className="ui-history-search-shell ui-history-compact-search">
            <Search size={12} />
            <input ref={globalSearchRef} value={globalQuery} onChange={(e) => onGlobalQueryChange(e.target.value)}
              aria-label={t("history.search.globalAria")} title={t("history.search.globalPlaceholder")}
              placeholder={t("history.search.compactPlaceholder")} />
          </div>
          <div ref={projectDropdownRef} className="ui-history-project-filter">
            <button type="button" onClick={() => setProjectMenuOpen((open) => !open)}
              className="ui-history-filter ui-focus-ring ui-history-project-trigger" aria-haspopup="tree"
              aria-expanded={projectMenuOpen} aria-label={`${t("history.projectFilter.source")}: ${selectedProjectLabel}`}
              title={projectPathFilter ?? t("history.allProjects")}>
              {selectedProject ? <ProjectFilterIcon project={selectedProject} size={11} /> : <Folder size={11} />}
              <span>{selectedProjectLabel}</span>
              <ChevronDown size={11} style={{ transform: projectMenuOpen ? "rotate(180deg)" : undefined }} />
            </button>
          {projectMenuOpen && (
            <div className="absolute left-0 right-0 top-full z-30 mt-1 rounded-xl border border-border/70 bg-surface-container-lowest p-1 shadow-lg">
              <div className="ui-history-search-shell mb-1 gap-2 px-2 py-1.5 text-text-secondary">
                <Search size={13} />
                <input
                  value={projectSearchQuery}
                  onChange={(e) => setProjectSearchQuery(e.target.value)}
                  aria-label={t("history.projectFilter.searchAria")}
                  placeholder={t("history.projectFilter.searchPlaceholder")}
                  className="flex-1 bg-transparent text-[12px] outline-none"
                />
                {projectSearchQuery && (
                  <button
                    type="button"
                    onClick={() => setProjectSearchQuery("")}
                    className="ui-flat-action inline-flex h-5 w-5 items-center justify-center rounded-md px-0 text-text-muted"
                    aria-label={t("history.projectFilter.clearSearch")}
                    title={t("history.projectFilter.clearSearch")}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
              <div
                ref={projectTreeScrollRef}
                className="ui-thin-scroll max-h-52 space-y-0.5 overflow-y-auto pr-1"
                role="tree"
                aria-label={t("history.projectFilter.treeAria")}
              >
                <button
                  type="button"
                  onClick={() => handleProjectFilterChange(null)}
                  className="ui-tree-node ui-tree-project ui-focus-ring flex h-7 w-full items-center gap-1.5 rounded-lg px-2 text-left text-[12px]"
                  data-selected={!projectPathFilter && !projectIdFilter ? "true" : "false"}
                >
                  <Folder size={13} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate font-medium">{t("history.allProjects")}</span>
                  <span className="ui-tree-count-badge rounded-full px-1.5 text-[10px] font-medium">{projects.length}</span>
                </button>
                {filteredProjectTree.length > 0 ? (
                  filteredProjectTree.map((node) => renderProjectNode(node))
                ) : (
                  <div className="px-2 py-1.5 text-[11px] text-text-muted">
                    {normalizedProjectSearch ? t("history.projectFilter.noMatches") : t("history.projectFilter.empty")}
                  </div>
                )}
                {normalizedProjectSearch && filteredProjectTree.length > 0 && (
                  <div className="px-2 py-1 text-[10px] text-text-muted">{t("history.projectFilter.matchCount", { count: filteredProjectCount })}</div>
                )}
              </div>
            </div>
          )}
          </div>
        </div>
        {globalQueryTooShort && (
          <div className="px-3 pt-1 text-[10px] text-text-muted">{t("history.search.minimumChars")}</div>
        )}
        {indexBusy && (
          <div className="px-3 pt-1 text-[10px] text-text-muted">
            {t("history.index.progress", {
              indexed: indexStatus.indexedFiles,
              total: indexStatus.totalFiles,
            })}
          </div>
        )}
        {indexStatus.phase === "error" && (
          <div className="px-3 pt-1 text-[10px] text-danger">{t("history.index.error")}</div>
        )}


        {selectionMode && (
          <div className="ui-history-compact-selection">
            <span>{t("history.bulk.selectedCount", { count: selectedCount })}</span>
            <button type="button" className="ui-flat-action ui-focus-ring ui-history-icon-button" onClick={onToggleSelectAllVisible}
              disabled={visibleSessionCount === 0} aria-pressed={allVisibleSelected}
              aria-label={t(allVisibleSelected ? "history.bulk.clearVisibleSelection" : "history.bulk.selectVisible")}
              title={t(allVisibleSelected ? "history.bulk.clearVisibleSelection" : "history.bulk.selectVisible")}>
              <Check size={12} />
            </button>
            <button type="button" className="ui-flat-action ui-focus-ring ui-history-icon-button text-danger" onClick={onDeleteSelected}
              disabled={selectedCount === 0} aria-label={t("history.bulk.deleteSelected", { count: selectedCount })}
              title={t("history.bulk.deleteSelected", { count: selectedCount })}>
              <Trash2 size={12} />
            </button>
          </div>
        )}
      </div>

      <div ref={sessionListRef} onScroll={onSessionListScroll} className="history-hierarchy-scroll flex-1 overflow-y-auto">
        <div className="relative w-full" style={{ height: rowVirtualizer.getTotalSize() }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) return null;
            const sessionDisplayTitle =
              row.type === "session"
                ? formatSessionListTitle(row.item.displayTitle, t("history.imagePlaceholder"))
                : "";
            const sessionWorktree = row.type === "session" ? getSessionWorktree(row.item) : null;
            const agentDescriptor = row.type === "group" ? HISTORY_SOURCE_DESCRIPTOR_BY_ID.get(row.source as HistorySourceId) : null;
            const agentLabel = agentDescriptor ? t(agentDescriptor.labelKey) : row.type === "group" ? row.source || t("history.agentGroup.other") : "";
            return (
              <div
                key={virtualRow.key}
                ref={rowVirtualizer.measureElement}
                data-index={virtualRow.index}
                className={`history-hierarchy-item absolute left-0 top-0 w-full${row.type === "session" || row.type === "missingParent" ? " history-family-fragment" : ""}`}
                data-family={row.type === "session" || row.type === "missingParent" ? row.familyKey : undefined}
                data-family-start={row.type === "session" || row.type === "missingParent" ? row.familyStart || undefined : undefined}
                data-family-end={row.type === "session" || row.type === "missingParent" ? row.familyEnd || undefined : undefined}
                data-family-expanded={row.type === "session" || row.type === "missingParent" ? row.familyExpanded || undefined : undefined}
                style={{
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {row.type === "loading" && <div className="px-3 py-4 text-xs text-text-muted">{t("history.loadingSessions")}</div>}

                {row.type === "searching" && (
                  <div className="px-3 py-2 text-[11px] text-text-muted">{t("history.searching")}</div>
                )}

                {row.type === "searchHeader" && (
                  <div className="px-3 py-2 text-[11px] font-semibold text-text-muted">
                    {indexStatus.partial
                      ? t("history.searchHitsPartial", { count: row.count })
                      : t("history.searchHits", { count: row.count })}
                  </div>
                )}

                {row.type === "searchHit" && (
                  <button
                    onClick={() => onOpenHit(row.hit)}
                    className="ui-list-row w-full border-t border-border px-3 py-2 text-left"
                  >
                    <div className="truncate text-xs font-semibold text-text-primary">{row.hit.title}</div>
                    <div className="mt-0.5 truncate text-[11px] text-text-secondary">{row.hit.snippet}</div>
                    <div className="ui-dev-label mt-1 flex items-center gap-1.5 text-[10px] text-text-muted">
                      <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-primary">
                        <SessionSourceIcon source={row.hit.source} size={11} />
                      </span>
                      <span className="truncate">
                        {row.hit.source} · {row.hit.project_key} · {row.hit.role}
                      </span>
                    </div>
                  </button>
                )}

                {row.type === "group" && (
                  <button type="button" className="history-agent-section ui-focus-ring"
                    onClick={() => toggleAgent(row.source)} aria-expanded={!collapsedAgents.has(row.source)}
                    aria-label={t(collapsedAgents.has(row.source) ? "history.agentGroup.expand" : "history.agentGroup.collapse", { agent: agentLabel })}>
                    <span className="history-agent-identity">
                      {collapsedAgents.has(row.source) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                      <SessionSourceIcon source={row.source} size={14} />
                      <span>{agentLabel}</span>
                    </span>
                    <span className="history-agent-counts">
                      {row.count > 0 && <span>{t("history.agentGroup.sessionCount", { count: row.count })}</span>}
                      {row.subagentCount > 0 && <span>{t("history.tree.childCount", { count: row.subagentCount })}</span>}
                    </span>
                  </button>
                )}

                {row.type === "missingParent" && (
                  <div className="history-missing-parent" title={`${t("history.tree.parentUnavailable")} · ${row.parentSessionId}`}>
                    <MessageSquare size={12} />
                    <span>{t("history.tree.parentUnavailable")}</span>
                  </div>
                )}

                {row.type === "session" && (
                  <div className="history-session-row" data-child={row.depth > 0 || undefined}
                    data-active={row.item.sessionKey === activeSessionKey || undefined}
                    data-expanded={row.childCount > 0 && expandedSessionParents.has(row.item.sessionKey) || undefined}
                    style={{ "--history-depth": row.depth } as CSSProperties}
                    onContextMenu={(e) => handleSessionContextMenu(e, row.item)}
                    onClick={selectionMode ? () => onToggleSessionSelection(row.item.sessionKey) : undefined}>
                    <span className="history-session-selection" aria-hidden="true" />
                    <span className="history-session-guides" aria-hidden="true">
                      {row.branches.map((continues, level) => <span key={level} className="history-tree-guide"
                        data-current={level === row.branches.length - 1 || undefined}
                        data-continues={continues || undefined}
                        style={{ "--history-guide-level": level } as CSSProperties} />)}
                    </span>
                    {row.childCount > 0 ? (
                      <button type="button" className="history-session-toggle ui-focus-ring"
                        onClick={(e) => { e.stopPropagation(); toggleSessionParent(row.item.sessionKey); }}
                        aria-expanded={expandedSessionParents.has(row.item.sessionKey)}
                        aria-label={t(expandedSessionParents.has(row.item.sessionKey) ? "history.tree.collapseChildren" : "history.tree.expandChildren", { count: row.childCount })}
                        title={t(expandedSessionParents.has(row.item.sessionKey) ? "history.tree.collapseChildren" : "history.tree.expandChildren", { count: row.childCount })}>
                        {expandedSessionParents.has(row.item.sessionKey) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      </button>
                    ) : <span className="history-session-node" aria-hidden="true">
                      {row.depth > 0 ? <Bot size={13} /> : <MessageSquare size={13} />}
                    </span>}
                    <button type="button" className="history-session-open ui-focus-ring"
                      onClick={selectionMode ? undefined : () => onOpenSession(row.item.sessionKey)}
                      tabIndex={selectionMode ? -1 : undefined}
                      aria-current={row.item.sessionKey === activeSessionKey ? "true" : undefined}
                      title={[sessionDisplayTitle, row.item.subagent?.nickname, formatTime(row.item.updated_at, language), t("history.messageCount", { count: row.item.message_count })].filter(Boolean).join("\n")}>
                      <span className="history-session-primary">
                        {row.item.starred && <Star size={10} className="shrink-0 text-warning" fill="currentColor" />}
                        <span className="history-session-title">{sessionDisplayTitle}</span>
                      </span>
                      <span className="history-session-meta">
                        {row.depth > 0 && <span className="history-session-kind">{t("history.tree.subagent")}</span>}
                        <time title={formatTime(row.item.updated_at, language)}>{row.depth > 0 ? formatSessionClock(row.item.updated_at) : formatTime(row.item.updated_at, language)}</time>
                        <span className="history-session-message-count" aria-label={t("history.messageCount", { count: row.item.message_count })} title={t("history.messageCount", { count: row.item.message_count })}>
                          <MessageSquare size={10} />{row.item.message_count}
                        </span>
                        {sessionWorktree && <span className="history-session-worktree" title={t("history.worktreeBadgeTitle", { name: sessionWorktree.name })}>{t("history.worktreeBadge")}</span>}
                        {row.childCount > 0 && <span className="history-session-children"><Bot size={11} />{t("history.tree.childCount", { count: row.childCount })}</span>}
                      </span>
                    </button>
                    <div className="history-session-actions">
                      {selectionMode ? <SelectionCheckbox checked={selectedSessionKeys.has(row.item.sessionKey)}
                        title={t("history.bulk.selectSessionNamed", { title: sessionDisplayTitle })}
                        ariaLabel={t("history.bulk.selectSessionNamed", { title: sessionDisplayTitle })}
                        onToggle={() => onToggleSessionSelection(row.item.sessionKey)} />
                      : !row.item.read_only && (row.item.source !== "claude" || !inferSubagentParentSessionId(row.item)) && (
                        <button type="button" onClick={() => onDeleteSession(row.item)} className="history-session-delete ui-focus-ring"
                          aria-label={t("history.deleteSessionNamed", { title: sessionDisplayTitle })} title={t("history.deleteSession")}>
                          <X size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {row.type === "empty" && (
                  <div className="px-3 py-5 text-center">
                    <div className="text-xs font-semibold text-text-secondary">{emptySessionCopy.title}</div>
                    <div className="mt-1 text-[11px] leading-relaxed text-text-muted">{emptySessionCopy.description}</div>
                  </div>
                )}

                {row.type === "loadMore" && (
                  <div className="p-2">
                    <button
                      onClick={onLoadMoreSessions}
                      className="ui-btn w-full"
                      aria-label={t("history.loadMore")}
                      disabled={loadingMoreSessions}
                    >
                      {loadingMoreSessions
                        ? t("history.loadingMore")
                        : loadMoreSessionMode === "local"
                          ? t("history.showMoreMatches", { visible: visibleSessionCount, total: filteredSessionCount })
                          : t("history.scanMore", { count: filteredSessionCount })}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {contextMenu && (
        <Portal>
          <div className="context-menu" style={{ left: menuX, top: menuY }} ref={contextMenuRef} role="menu">
            <button className="context-menu-item" role="menuitem" onClick={handleContextMenuResume}>
              <RefreshCw size={13} aria-hidden="true" />
              <span>{t("history.menu.resumeInTerminal")}</span>
            </button>
            {canConvertSession(contextMenu.session) ? (
              <button className="context-menu-item" role="menuitem" onClick={handleContextMenuConvert}>
                <ArrowRightLeft size={13} aria-hidden="true" />
                <span>
                  {contextMenu.session.source === "claude"
                    ? t("history.menu.convertToCodex")
                    : t("history.menu.convertToClaude")}
                </span>
              </button>
            ) : null}
            <button className="context-menu-item danger" role="menuitem" onClick={handleContextMenuDelete}>
              <Trash2 size={13} aria-hidden="true" />
              <span>{t("common.delete")}</span>
            </button>
          </div>
        </Portal>
      )}

      <div
        onMouseDown={onStartResize}
        className="ui-history-resize-handle absolute bottom-0 right-0 top-0 z-10 w-1.5 cursor-col-resize transition-colors"
        style={{ opacity: 0.6 }}
      />
    </aside>
  );
}
