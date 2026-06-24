import { useCallback, useMemo, useState } from "react";
import { getMaterialFileIcon, getMaterialFolderIcon } from "@baybreezy/file-extension-icon";
import type { GitFileChange, ProjectFileEntry } from "../../lib/types";
import { useFileExplorerStore } from "../../stores/fileExplorerStore";
import { STATUS_CONFIG } from "../git/GitStatusIcon";
import { ConfirmDialog } from "../ConfirmDialog";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "../ui/dialog";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "../ui/context-menu";
import { ChevronRight, Copy, File, Folder, FolderPlus, RefreshCw, Search, Trash2, X } from "../icons";

type InputAction =
  | { kind: "create-file"; parentPath: string }
  | { kind: "create-dir"; parentPath: string }
  | { kind: "rename"; path: string; currentName: string };

type ConfirmAction =
  | { kind: "delete"; path: string; name: string }
  | { kind: "overwrite-create"; action: InputAction; value: string }
  | { kind: "overwrite-paste"; targetParentPath: string };

type FileDisplayStatus =
  | { kind: "editing"; label: string; color: string }
  | { kind: "git"; label: string; color: string };

const EDITING_STATUS: FileDisplayStatus = {
  kind: "editing",
  label: "编辑",
  color: "#7dcfff",
};

const GIT_STATUS_LABELS: Record<GitFileChange["status"], string> = {
  M: "修改",
  A: "新增",
  D: "删除",
  R: "重命名",
  C: "冲突",
  U: "未提交",
  "??": "未提交",
};

function makeGitDisplayStatus(change: GitFileChange): FileDisplayStatus {
  const config = STATUS_CONFIG[change.status] ?? STATUS_CONFIG.M;
  return {
    kind: "git",
    label: GIT_STATUS_LABELS[change.status],
    color: config.color,
  };
}

function FileNode({
  entry,
  depth,
  getDisplayStatus,
  onOpenFile,
  onInput,
  onConfirm,
}: {
  entry: ProjectFileEntry;
  depth: number;
  getDisplayStatus: (entry: ProjectFileEntry) => FileDisplayStatus | null;
  onOpenFile: (entry: ProjectFileEntry) => void;
  onInput: (action: InputAction) => void;
  onConfirm: (action: ConfirmAction) => void;
}) {
  const expandedPaths = useFileExplorerStore((s) => s.expandedPaths);
  const toggleDir = useFileExplorerStore((s) => s.toggleDir);
  const setClipboard = useFileExplorerStore((s) => s.setClipboard);
  const pasteInto = useFileExplorerStore((s) => s.pasteInto);
  const clipboard = useFileExplorerStore((s) => s.clipboard);
  const activePath = useFileExplorerStore((s) => s.activeFile?.path ?? null);
  const isDir = entry.kind === "directory";
  const isOpen = isDir && expandedPaths.has(entry.path);
  const icon = isDir ? getMaterialFolderIcon(entry.name, isOpen) : getMaterialFileIcon(entry.name);
  const paddingLeft = 8 + depth * 14;
  const displayStatus = getDisplayStatus(entry);

  const paste = async () => {
    try {
      await pasteInto(entry.path, false);
    } catch (err) {
      if (String(err).includes("target_exists")) {
        onConfirm({ kind: "overwrite-paste", targetParentPath: entry.path });
        return;
      }
      throw err;
    }
  };

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            className="ui-file-tree-row flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-[12px]"
            data-selected={activePath === entry.path ? "true" : "false"}
            style={{ paddingLeft }}
            title={displayStatus ? `${entry.path} · ${displayStatus.label}` : entry.path}
            onContextMenu={(event) => event.stopPropagation()}
            onClick={() => {
              if (isDir) void toggleDir(entry.path);
              else onOpenFile(entry);
            }}
          >
            <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-text-muted">
              {isDir ? (
                <ChevronRight size={12} style={{ transform: isOpen ? "rotate(90deg)" : "rotate(0deg)" }} />
              ) : null}
            </span>
            <img src={icon} alt="" width={16} height={16} className="shrink-0" />
            <span
              className="min-w-0 flex-1 truncate"
              style={displayStatus ? { color: displayStatus.color } : undefined}
            >
              {entry.name}
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {isDir && (
            <>
              <ContextMenuItem onSelect={() => onInput({ kind: "create-file", parentPath: entry.path })}>
                <File size={13} /> 新建文件
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => onInput({ kind: "create-dir", parentPath: entry.path })}>
                <FolderPlus size={13} /> 新建文件夹
              </ContextMenuItem>
              <ContextMenuItem disabled={!clipboard} onSelect={() => void paste()}>
                <Copy size={13} /> 粘贴
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem onSelect={() => onInput({ kind: "rename", path: entry.path, currentName: entry.name })}>
            重命名
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => setClipboard({ mode: "copy", path: entry.path, name: entry.name })}>
            复制
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => setClipboard({ mode: "move", path: entry.path, name: entry.name })}>
            移动
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem danger onSelect={() => onConfirm({ kind: "delete", path: entry.path, name: entry.name })}>
            <Trash2 size={13} /> 删除
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {isDir && isOpen && entry.children && (
        <div>
          {entry.children.map((child) => (
            <FileNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              getDisplayStatus={getDisplayStatus}
              onOpenFile={onOpenFile}
              onInput={onInput}
              onConfirm={onConfirm}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileExplorerSidebar() {
  const project = useFileExplorerStore((s) => s.project);
  const tree = useFileExplorerStore((s) => s.tree);
  const searchQuery = useFileExplorerStore((s) => s.searchQuery);
  const searchResults = useFileExplorerStore((s) => s.searchResults);
  const activeFile = useFileExplorerStore((s) => s.activeFile);
  const openFiles = useFileExplorerStore((s) => s.openFiles);
  const gitChanges = useFileExplorerStore((s) => s.gitChanges);
  const clipboard = useFileExplorerStore((s) => s.clipboard);
  const closeProject = useFileExplorerStore((s) => s.closeProject);
  const refresh = useFileExplorerStore((s) => s.refresh);
  const setSearchQuery = useFileExplorerStore((s) => s.setSearchQuery);
  const openFile = useFileExplorerStore((s) => s.openFile);
  const createEntry = useFileExplorerStore((s) => s.createEntry);
  const renameEntry = useFileExplorerStore((s) => s.renameEntry);
  const deleteEntry = useFileExplorerStore((s) => s.deleteEntry);
  const pasteInto = useFileExplorerStore((s) => s.pasteInto);
  const [inputAction, setInputAction] = useState<InputAction | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  const visibleRows = searchQuery.trim() ? searchResults : tree;
  const gitChangeByPath = useMemo(() => new Map(gitChanges.map((change) => [change.path, change])), [gitChanges]);
  const dirtyFilePaths = useMemo(
    () => new Set(openFiles.filter((file) => file.content !== file.savedContent).map((file) => file.path)),
    [openFiles]
  );

  const getDisplayStatus = useCallback((entry: ProjectFileEntry): FileDisplayStatus | null => {
    if (entry.kind !== "file") return null;
    if (dirtyFilePaths.has(entry.path)) return EDITING_STATUS;
    const change = gitChangeByPath.get(entry.path);
    return change ? makeGitDisplayStatus(change) : null;
  }, [dirtyFilePaths, gitChangeByPath]);

  const openInput = (action: InputAction) => {
    setInputAction(action);
    setInputValue(action.kind === "rename" ? action.currentName : "");
  };

  const performInputAction = useCallback(async (action: InputAction, rawValue: string, overwrite = false) => {
    const value = rawValue.trim();
    if (!value) return;
    try {
      if (action.kind === "create-file") {
        await createEntry(action.parentPath, value, "file", overwrite);
      } else if (action.kind === "create-dir") {
        await createEntry(action.parentPath, value, "directory", overwrite);
      } else {
        await renameEntry(action.path, value, overwrite);
      }
      setInputAction(null);
      setInputValue("");
    } catch (err) {
      if (String(err).includes("target_exists")) {
        setConfirmAction({ kind: "overwrite-create", action, value });
        return;
      }
      throw err;
    }
  }, [createEntry, renameEntry]);

  const submitInput = useCallback(async (overwrite = false) => {
    if (!inputAction) return;
    await performInputAction(inputAction, inputValue, overwrite);
  }, [inputAction, inputValue, performInputAction]);

  const requestOpenFile = (entry: ProjectFileEntry) => {
    void openFile(entry);
  };

  const renderSearchRow = useCallback((entry: ProjectFileEntry) => {
    const displayStatus = getDisplayStatus(entry);
    return (
      <button
        key={entry.path}
        type="button"
        className="ui-file-tree-row flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px]"
        data-selected={activeFile?.path === entry.path ? "true" : "false"}
        onClick={() => entry.kind === "file" ? requestOpenFile(entry) : undefined}
        onContextMenu={(event) => event.stopPropagation()}
        title={displayStatus ? `${entry.path} · ${displayStatus.label}` : entry.path}
      >
        <img src={entry.kind === "directory" ? getMaterialFolderIcon(entry.name, false) : getMaterialFileIcon(entry.name)} alt="" width={16} height={16} />
        <span
          className="min-w-0 flex-1 truncate"
          style={displayStatus ? { color: displayStatus.color } : undefined}
        >
          {entry.path}
        </span>
      </button>
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile?.path, getDisplayStatus, openFile]);

  const renderRows = useMemo(() => (
    visibleRows.length > 0 ? visibleRows.map((entry) => (
      searchQuery.trim() ? (
        renderSearchRow(entry)
      ) : (
        <FileNode
          key={entry.path}
          entry={entry}
          depth={0}
          getDisplayStatus={getDisplayStatus}
          onOpenFile={requestOpenFile}
          onInput={openInput}
          onConfirm={setConfirmAction}
        />
      )
    )) : (
      <div className="px-3 py-8 text-center text-xs text-text-muted">没有文件</div>
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [searchQuery, visibleRows, renderSearchRow, getDisplayStatus]);

  if (!project) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border px-2 py-2">
        <div className="mb-2 flex items-center gap-2">
          <Folder size={15} className="text-on-surface-variant" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-semibold text-on-surface">{project.name}</div>
            <div className="truncate text-[10px] text-text-muted">{project.path}</div>
          </div>
          <button className="ui-icon-action" title="刷新" aria-label="刷新文件列表" onClick={() => void refresh()}>
            <RefreshCw size={13} />
          </button>
          <button className="ui-icon-action" title="返回项目树" aria-label="返回项目树" onClick={closeProject}>
            <X size={14} />
          </button>
        </div>
        <div className="flex items-center gap-1 rounded-md border border-border bg-surface-container-lowest px-2">
          <Search size={13} className="text-text-muted" />
          <input
            className="min-w-0 flex-1 bg-transparent py-1.5 text-xs text-on-surface outline-none"
            value={searchQuery}
            placeholder="搜索文件"
            onChange={(event) => void setSearchQuery(event.currentTarget.value)}
          />
        </div>
        {clipboard && <div className="mt-1 truncate text-[10px] text-text-muted">{clipboard.mode === "copy" ? "复制" : "移动"}：{clipboard.name}</div>}
      </div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
            {renderRows}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => openInput({ kind: "create-file", parentPath: "" })}>
            <File size={13} /> 新建文件
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => openInput({ kind: "create-dir", parentPath: "" })}>
            <FolderPlus size={13} /> 新建文件夹
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <Dialog open={inputAction !== null} onOpenChange={(open) => { if (!open) setInputAction(null); }}>
        <DialogContent className="max-w-[360px]">
          <DialogTitle>{inputAction?.kind === "rename" ? "重命名" : inputAction?.kind === "create-dir" ? "新建文件夹" : "新建文件"}</DialogTitle>
          <input
            className="ui-focus-ring mt-3 rounded-md border border-border bg-surface-container-lowest px-3 py-2 text-sm text-on-surface outline-none"
            value={inputValue}
            autoFocus
            onChange={(event) => setInputValue(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submitInput(false);
              if (event.key === "Escape") setInputAction(null);
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setInputAction(null)}>取消</Button>
            <Button onClick={() => void submitInput(false)}>确定</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmAction?.kind === "delete"}
        title="确认删除？"
        message={confirmAction?.kind === "delete" ? `将删除 "${confirmAction.name}"。此操作不可撤销。` : undefined}
        confirmText="删除"
        danger
        onClose={() => setConfirmAction(null)}
        onConfirm={() => {
          const action = confirmAction;
          setConfirmAction(null);
          if (action?.kind === "delete") void deleteEntry(action.path);
        }}
      />
      <ConfirmDialog
        open={confirmAction?.kind === "overwrite-create" || confirmAction?.kind === "overwrite-paste"}
        title="目标已存在"
        message="是否覆盖目标文件或目录？"
        confirmText="覆盖"
        danger
        onClose={() => setConfirmAction(null)}
        onConfirm={() => {
          const action = confirmAction;
          setConfirmAction(null);
          if (action?.kind === "overwrite-create") {
            void performInputAction(action.action, action.value, true);
          }
          if (action?.kind === "overwrite-paste") {
            void pasteInto(action.targetParentPath, true);
          }
        }}
      />
    </div>
  );
}
