import { useState, useEffect, useRef, memo, type PointerEvent as ReactPointerEvent, type FocusEvent as ReactFocusEvent } from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { TreeNode as TNode } from "../../lib/types";
import { useTreeActions, worktreeListCollapseId } from "./TreeContext";
import { Folder, FolderCode, Play, Plus, MoreHorizontal, ChevronRight } from "../icons";
import { WorkspaceCard } from "./WorkspaceCard";
import { useProjectBranch } from "../../hooks/useProjectBranch";
import { projectSupportsCapability } from "../../lib/projectCapabilities";
import { useI18n } from "../../lib/i18n";
import { DND_SORTABLE_TRANSITION } from "../../lib/dragInteraction";

function preventSecondaryPointerFocus(event: ReactPointerEvent<HTMLElement>) {
  if (event.button !== 2) return;
  event.preventDefault();
  event.stopPropagation();
}

function InlineRename({ initial, onConfirm, onCancel }: { initial: string; onConfirm: (name: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const submit = () => {
    const trimmed = value.trim();
    if (trimmed) onConfirm(trimmed);
    else onCancel();
  };

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={submit}
      onKeyDown={(e) => {
        if (e.key === "Enter") submit();
        if (e.key === "Escape") onCancel();
      }}
      className="ui-tree-inline-input ui-focus-ring h-8 flex-1 px-2 text-xs text-on-surface outline-none"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}

interface TreeNodeItemProps {
  node: TNode;
  depth: number;
  parentGroupId?: string | null;
  density: "compact" | "comfortable";
  focusedNodeKey: string | null;
  onFocusNode: (key: string) => void;
  forceExpanded?: boolean;
  sortableEnabled?: boolean;
}

function TreeNodeItemImpl({
  node,
  depth,
  parentGroupId = null,
  density,
  focusedNodeKey,
  onFocusNode,
  forceExpanded = false,
  sortableEnabled = true,
}: TreeNodeItemProps) {
  const { t } = useI18n();
  const actions = useTreeActions();
  const branch = useProjectBranch(node.type === "project" ? node.project : null);
  const itemId = node.type === "group" ? node.group.id : node.type === "project" ? node.project.id : `wt:${node.worktree.id}`;
  const { active, attributes, isOver, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: itemId,
    data: { parentGroupId },
    disabled: !sortableEnabled || node.type === "worktree",
    transition: DND_SORTABLE_TRANSITION,
  });
  // Disabling sorting must not disable selection or keyboard navigation.
  const treeAttributes = { ...attributes, "aria-disabled": undefined };
  const showCrossGroupDropPreview = Boolean(
    isOver &&
    active &&
    active.id !== itemId &&
    active.data.current?.parentGroupId !== parentGroupId
  );
  const sortableStyle = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? undefined : transition,
    opacity: isDragging ? 0.5 : 1,
  };
  const compact = density === "compact";
  const indentBase = compact ? 6 : 8;
  const indentStep = compact ? 14 : 16;
  const paddingLeft = indentBase + depth * indentStep;

  const handleNodeFocus = (event: ReactFocusEvent<HTMLDivElement>) => {
    // Child tree items bubble focus through their parent project/group.
    if ((event.target as HTMLElement).closest('[role="treeitem"]') === event.currentTarget) {
      onFocusNode(node.type === "group" ? `g:${node.group.id}` : node.type === "worktree" ? `wt:${node.worktree.id}` : `p:${node.project.id}`);
    }
  };

  if (node.type === "worktree") {
    const { project, worktree } = node;
    const treeKey = `wt:${worktree.id}`;
    const selected = actions.selectedId === worktree.id || actions.selectedWorktreeIds.has(worktree.id);
    return (
      <div ref={setNodeRef} style={sortableStyle} {...treeAttributes} role="treeitem"
        data-tree-key={treeKey} aria-level={depth + 1} aria-selected={selected}
        tabIndex={focusedNodeKey === treeKey ? 0 : -1} onFocus={handleNodeFocus}>
        <WorkspaceCard project={project} worktree={worktree} name={worktree.name} branch={worktree.branch}
          selected={selected} compact={compact} invalid={worktree.status === "missing"}
          onSelect={(e) => actions.onSelectWorktree(e, worktree)}
          onOpen={() => actions.onOpenWorktree(project, worktree)}
          onContextMenu={(e) => actions.onContextMenuWorktree(e, project, worktree)} />
      </div>
    );
  }

  if (node.type === "project") {
    const p = node.project;
    const treeKey = `p:${p.id}`;
    const selected = actions.selectedId === p.id || actions.selectedProjectIds.has(p.id);
    const projectWorktrees = node.worktrees ?? [];
    const collapseKey = worktreeListCollapseId(p.id);
    const open = forceExpanded || !actions.collapsedIds.has(collapseKey);
    return (
      <div ref={setNodeRef} style={sortableStyle} {...treeAttributes} role="treeitem"
        className="ui-project-section" data-tree-key={treeKey} aria-level={depth + 1}
        aria-expanded={open} aria-selected={selected}
        tabIndex={focusedNodeKey === treeKey ? 0 : -1}
        onPointerDownCapture={preventSecondaryPointerFocus} onFocus={handleNodeFocus}>
        {showCrossGroupDropPreview && <span className="ui-project-insertion" aria-hidden="true" />}
        <div className="ui-project-heading group/item" style={{ paddingLeft: depth * indentStep + 5 }}
          onContextMenu={(e) => actions.onContextMenuProjectHeader(e, p)} {...listeners}>
          {actions.renamingProjectId === p.id
            ? <><FolderCode size={14} /><InlineRename initial={p.name} onConfirm={(name) => actions.onProjectRenameConfirm(p.id, name)} onCancel={actions.onCancelProjectRename} /></>
            : <button type="button" className="ui-project-heading-name ui-focus-ring"
                aria-expanded={open} title={p.path}
                onClick={() => { if (!forceExpanded) actions.toggleCollapsed(collapseKey); }}>
                <FolderCode size={14} strokeWidth={1.5} /><span>{p.name}</span>
              </button>}
          <span className="ui-project-heading-actions" onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") e.stopPropagation(); }}>
            <button type="button" className="ui-sidebar-tool ui-focus-ring" aria-label={t("workspace.projectActions", { name: p.name })}
              onPointerDown={(e) => e.stopPropagation()} onClick={(e) => actions.onContextMenuProjectHeader(e, p)}><MoreHorizontal size={14} /></button>
            {projectSupportsCapability(p, "worktree") && <button type="button" className="ui-sidebar-tool ui-focus-ring"
              aria-label={t("workspace.create")} title={t("workspace.create")}
              onPointerDown={(e) => e.stopPropagation()} onClick={() => actions.onCreateWorktree(p)}><Plus size={14} /></button>}
            <button type="button" className="ui-sidebar-tool ui-focus-ring" aria-label={t(open ? "sidebar.tree.collapseWorktrees" : "sidebar.tree.expandWorktrees")}
              onPointerDown={(e) => e.stopPropagation()} onClick={() => { if (!forceExpanded) actions.toggleCollapsed(collapseKey); }}>
              <ChevronRight size={12} style={{ transform: open ? "rotate(90deg)" : undefined }} />
            </button>
          </span>
        </div>
        {open && <div className="ui-project-workspaces" style={{ marginLeft: depth * indentStep }}>
          <WorkspaceCard project={p} name={branch || t("workspace.primaryName")} branch={branch || (p.environment_type === "ssh" ? p.remote_path || p.path : p.path)}
            primary selected={selected} compact={compact} invalid={actions.isPathInvalid(p.id)}
            onSelect={(e) => actions.onSelectProject(e, p)} onOpen={() => actions.onOpenProject(p)}
            onContextMenu={(e) => actions.onContextMenuProject(e, p)} />
          {projectWorktrees.length > 0 && <div role="group" className="ui-worktree-children">
            {projectWorktrees.map((worktree) => <TreeNodeItem key={`wt:${worktree.id}`} node={{ type: "worktree", project: p, worktree }}
              depth={depth + 1} parentGroupId={parentGroupId} density={density} focusedNodeKey={focusedNodeKey}
              onFocusNode={onFocusNode} forceExpanded={forceExpanded} sortableEnabled={false} />)}
          </div>}
        </div>}
      </div>
    );
  }

  const g = node.group;
  const treeKey = `g:${g.id}`;
  const isOpen = forceExpanded || !actions.collapsedIds.has(g.id);
  const isSelected =
    actions.projectScopedTerminalViewEnabled &&
    actions.terminalScope.kind === "group" &&
    actions.terminalScope.groupId === g.id;
  const isMultiSelected = actions.selectedGroupIds.has(g.id);
  const { setNodeRef: setIntoRef, isOver: isOverInto } = useDroppable({ id: `into:${g.id}` });

  if (actions.renamingGroupId === g.id) {
    return (
      <div
        ref={setNodeRef}
        style={{ ...sortableStyle }}
        {...treeAttributes}
        role="treeitem"
        data-tree-key={treeKey}
        aria-level={depth + 1}
        aria-expanded="true"
        aria-selected={false}
        tabIndex={focusedNodeKey === treeKey ? 0 : -1}
        onFocus={handleNodeFocus}
      >
        <div className={`flex items-center px-2 ${compact ? "gap-1 py-1" : "gap-1.5 py-1.5"}`}>
          <ChevronRight size={12} strokeWidth={2} style={{ transform: "rotate(90deg)" }} />
          <InlineRename initial={g.name} onConfirm={(name) => actions.onRenameConfirm(g.id, name)} onCancel={actions.onCancelRename} />
        </div>
      </div>
    );
  }

  return (
    <div
      ref={setNodeRef}
      className={showCrossGroupDropPreview ? "relative" : undefined}
      style={{ ...sortableStyle }}
      {...treeAttributes}
      role="treeitem"
      data-tree-key={treeKey}
      aria-level={depth + 1}
      aria-expanded={isOpen}
      aria-selected={isSelected || isMultiSelected}
      tabIndex={focusedNodeKey === treeKey ? 0 : -1}
      onPointerDownCapture={preventSecondaryPointerFocus}
      onFocus={handleNodeFocus}
    >
      {showCrossGroupDropPreview && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute z-10 h-0.5 rounded-full bg-primary"
          style={{ left: paddingLeft, right: compact ? 8 : 10, top: -1 }}
        />
      )}
      <div className={`ui-tree-group-shell ${compact ? "my-0.5" : "my-1"}`} style={{ marginLeft: depth === 0 ? 0 : 2 }}>
        <div
          ref={setIntoRef}
          className={`ui-tree-node ui-tree-group ui-focus-ring flex items-center rounded-xl font-semibold cursor-pointer group/grp ${
            compact ? "gap-1.5 py-1 text-[11px]" : "gap-2 py-1.5 text-[12px]"
          }`}
          data-selected={isSelected || isMultiSelected ? "true" : "false"}
          data-open={isOpen ? "true" : "false"}
          data-drop-target={isOverInto ? "true" : "false"}
          style={{ paddingLeft, paddingRight: compact ? 8 : 10, color: "var(--text-secondary)" }}
          onMouseDown={(e) => {
            if (e.button === 2) e.preventDefault();
          }}
          onClick={(e) => actions.onSelectGroup(e, g.id, forceExpanded)}
          onContextMenu={(e) => actions.onContextMenuGroup(e, g.id, g.name)}
          {...listeners}
        >
          <span className="ui-tree-chevron inline-flex items-center justify-center">
            <ChevronRight size={12} strokeWidth={2} style={{ transition: "transform 150ms", transform: isOpen ? "rotate(90deg)" : "rotate(0)" }} />
          </span>
          <span className="ui-tree-leading-icon"><Folder size={16} strokeWidth={1.5} /></span>
          <span className="flex-1 text-left truncate">{g.name}</span>
          <span className="ui-tree-item-actions hidden shrink-0 items-center gap-0.5 group-hover/grp:flex group-focus-within/grp:flex">
            <button onClick={(e) => { e.stopPropagation(); actions.onStartGroup(g.id); }} className="icon-btn" title={t("sidebar.tree.startDirectory")}><Play size={14} strokeWidth={1.5} /></button>
          </span>
        </div>

        {actions.newGroupParentId === g.id && (
          <div
            className={`flex items-center ${compact ? "gap-1.5 py-1" : "gap-2 py-1.5"}`}
            style={{ paddingLeft: paddingLeft + indentStep, paddingRight: compact ? 8 : 10 }}
          >
            <span className="ui-tree-leading-icon"><Folder size={16} strokeWidth={1.5} /></span>
            <InlineRename initial="" onConfirm={(name) => actions.onCreateGroup(g.id, name)} onCancel={actions.onCancelNewGroup} />
          </div>
        )}

        {isOpen && node.children.length > 0 && (
          <div className="tree-collapse" data-open="true">
            <div className="tree-collapse-inner" role="group">
              <SortableContext items={node.children.map((c) => c.type === "group" ? c.group.id : c.type === "project" ? c.project.id : `wt:${c.worktree.id}`)} strategy={verticalListSortingStrategy}>
                <div className={`${compact ? "ml-2 space-y-0.5 pb-0.5" : "ml-2.5 space-y-0.5 pb-1"}`}>
                  {node.children.map((child) => (
                    <TreeNodeItem
                      key={child.type === "group" ? `g:${child.group.id}` : child.type === "project" ? `p:${child.project.id}` : `wt:${child.worktree.id}`}
                      node={child}
                      depth={depth + 1}
                      parentGroupId={g.id}
                      density={density}
                      focusedNodeKey={focusedNodeKey}
                      onFocusNode={onFocusNode}
                      forceExpanded={forceExpanded}
                      sortableEnabled={sortableEnabled}
                    />
                  ))}
                </div>
              </SortableContext>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// 整树 memo 化：递归子节点是新 React element 但 type 指向同一 memo 组件，
// React 会按 props 浅比较跳过未变化分支的 render（绝大多数父组件刷新场景下 node 引用稳定）。
export const TreeNodeItem = memo(TreeNodeItemImpl);
