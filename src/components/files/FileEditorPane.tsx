import Editor from "@monaco-editor/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { TerminalSession } from "../../lib/types";
import { configureMonaco, languageFromPath } from "../../lib/monacoSetup";
import { useSettingsStore } from "../../stores/settingsStore";
import { useFileExplorerStore } from "../../stores/fileExplorerStore";
import { MarkdownContent } from "../ui/MarkdownContent";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../ui/dialog";
import { FileCode, Image, Save, X } from "../icons";

configureMonaco();

interface FileEditorPaneProps {
  session: TerminalSession;
  isActive: boolean;
  onClose: () => void;
}

type PendingAction =
  | { kind: "close-pane" }
  | { kind: "close-file"; path: string }
  | null;

export function FileEditorPane({ session, isActive, onClose }: FileEditorPaneProps) {
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);
  const project = useFileExplorerStore((s) => s.project);
  const openProject = useFileExplorerStore((s) => s.openProject);
  const openFiles = useFileExplorerStore((s) => s.openFiles);
  const activeFilePath = useFileExplorerStore((s) => s.activeFilePath);
  const activeFile = useFileExplorerStore((s) => s.activeFile);
  const setActiveFilePath = useFileExplorerStore((s) => s.setActiveFilePath);
  const closeFile = useFileExplorerStore((s) => s.closeFile);
  const setActiveContent = useFileExplorerStore((s) => s.setActiveContent);
  const saveFile = useFileExplorerStore((s) => s.saveFile);
  const saveActiveFile = useFileExplorerStore((s) => s.saveActiveFile);
  const [previewMode, setPreviewMode] = useState<"source" | "preview">("source");
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const ownsFileState = Boolean(project?.id && session.fileEditor?.projectId && project.id === session.fileEditor.projectId);
  const visibleFiles = ownsFileState ? openFiles : [];
  const visibleFile = ownsFileState ? activeFile : null;
  const dirty = Boolean(visibleFile && visibleFile.content !== visibleFile.savedContent);
  const dirtyFiles = visibleFiles.filter((file) => file.content !== file.savedContent);
  const language = useMemo(() => visibleFile ? languageFromPath(visibleFile.path) : "plaintext", [visibleFile]);

  useEffect(() => {
    const fileProject = session.fileEditor?.project;
    if (!isActive || !project || !fileProject || project.id === fileProject.id) return;
    void openProject(fileProject);
  }, [isActive, openProject, project?.id, session.fileEditor?.project]);

  useEffect(() => {
    setPreviewMode("source");
  }, [visibleFile?.path]);

  const save = useCallback(async () => {
    if (!visibleFile || visibleFile.previewKind === "image") return;
    await saveActiveFile();
  }, [saveActiveFile, visibleFile]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!isActive) return;
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      void save();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isActive, save]);

  const requestClose = () => {
    if (dirtyFiles.length > 0) {
      setPendingAction({ kind: "close-pane" });
      return;
    }
    onClose();
  };

  const discardAndRun = () => {
    setPendingAction(null);
    if (pendingAction?.kind === "close-file") {
      closeFile(pendingAction.path);
      return;
    }
    visibleFiles.forEach((file) => closeFile(file.path));
    onClose();
  };

  const saveAndRun = async () => {
    if (pendingAction?.kind === "close-file") {
      await saveFile(pendingAction.path);
      closeFile(pendingAction.path);
      setPendingAction(null);
      return;
    }
    for (const file of dirtyFiles) {
      await saveFile(file.path);
    }
    visibleFiles.forEach((file) => closeFile(file.path));
    setPendingAction(null);
    onClose();
  };

  const requestCloseFile = (path: string) => {
    const file = visibleFiles.find((item) => item.path === path);
    if (!file) return;
    if (file.content !== file.savedContent) {
      setPendingAction({ kind: "close-file", path });
      return;
    }
    closeFile(path);
  };

  return (
    <div className="ui-file-editor-pane flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="ui-file-editor-header flex h-10 shrink-0 items-center gap-2 border-b border-border bg-surface-container-low px-3">
        <FileCode size={15} strokeWidth={1.8} className="text-on-surface-variant" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-on-surface">
            {visibleFile ? visibleFile.name : session.fileEditor?.projectName ?? project?.name ?? "文件编辑器"}
            {dirty ? " *" : ""}
          </div>
          <div className="truncate text-[10px] text-text-muted">
            {visibleFile?.path ?? session.fileEditor?.projectPath ?? project?.path ?? "未选择文件"}
          </div>
        </div>
        {visibleFile?.previewKind === "markdown" && (
          <div className="ui-file-editor-segment flex rounded-md border border-border bg-surface-container-lowest p-0.5">
            <button
              type="button"
              className="rounded px-2 py-1 text-[11px]"
              data-active={previewMode === "source" ? "true" : "false"}
              onClick={() => setPreviewMode("source")}
            >
              源码
            </button>
            <button
              type="button"
              className="rounded px-2 py-1 text-[11px]"
              data-active={previewMode === "preview" ? "true" : "false"}
              onClick={() => setPreviewMode("preview")}
            >
              预览
            </button>
          </div>
        )}
        <Button size="sm" variant="outline" disabled={!dirty} onClick={() => void save()}>
          <Save size={13} />
          保存
        </Button>
        <button type="button" className="ui-icon-action" title="关闭文件编辑器" aria-label="关闭文件编辑器" onClick={requestClose}>
          <X size={15} />
        </button>
      </div>

      {visibleFiles.length > 0 && (
        <div className="flex h-8 shrink-0 items-center overflow-x-auto border-b border-border bg-surface-container-lowest px-1">
          {visibleFiles.map((file) => {
            const isActiveFile = file.path === activeFilePath;
            const isDirty = file.content !== file.savedContent;
            return (
              <div
                key={file.path}
                className="group flex h-7 max-w-[180px] shrink-0 items-center rounded-t text-[11px] text-on-surface-variant hover:bg-surface-container-high"
                data-active={isActiveFile ? "true" : "false"}
                style={isActiveFile ? { background: "var(--surface-container)", color: "var(--on-surface)" } : undefined}
                title={file.path}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate px-2 text-left"
                  onClick={() => setActiveFilePath(file.path)}
                >
                  {file.name}{isDirty ? " *" : ""}
                </button>
                <button
                  type="button"
                  className="mr-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-70 hover:bg-surface-container-highest hover:opacity-100"
                  aria-label={`关闭 ${file.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    requestCloseFile(file.path);
                  }}
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden bg-surface">
        {!visibleFile && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-text-muted">
            <FileCode size={36} strokeWidth={1.2} />
            <div className="text-sm">从左侧文件树选择文件</div>
          </div>
        )}
        {visibleFile?.previewKind === "unsupported" && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-text-muted">
            <FileCode size={36} strokeWidth={1.2} />
            <div className="text-sm">此文件无法作为文本或图片预览</div>
          </div>
        )}
        {visibleFile?.previewKind === "image" && visibleFile.image && (
          <div className="flex h-full items-center justify-center overflow-auto bg-surface-container-lowest p-4">
            <div className="flex max-h-full max-w-full flex-col items-center gap-3">
              <img
                src={`data:${visibleFile.image.mimeType};base64,${visibleFile.image.dataBase64}`}
                alt={visibleFile.name}
                className="max-h-[calc(100vh-180px)] max-w-full rounded border border-border object-contain"
              />
              <div className="flex items-center gap-2 text-xs text-text-muted">
                <Image size={13} />
                {(visibleFile.image.sizeBytes / 1024).toFixed(1)} KB
              </div>
            </div>
          </div>
        )}
        {visibleFile && (visibleFile.previewKind === "text" || visibleFile.previewKind === "markdown") && (
          visibleFile.previewKind === "markdown" && previewMode === "preview" ? (
            <div className="h-full overflow-auto p-4">
              <MarkdownContent content={visibleFile.content} linkBehavior="preview" />
            </div>
          ) : (
            <Editor
              path={visibleFile.path}
              value={visibleFile.content}
              language={language}
              theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
              onChange={(value) => setActiveContent(value ?? "")}
              options={{
                automaticLayout: true,
                fontSize: 13,
                minimap: { enabled: true },
                scrollBeyondLastLine: false,
                wordWrap: "on",
              }}
            />
          )
        )}
      </div>

      <Dialog open={pendingAction !== null} onOpenChange={(open) => { if (!open) setPendingAction(null); }}>
        <DialogContent className="max-w-[420px]">
          <DialogTitle>文件有未保存修改</DialogTitle>
          <DialogDescription className="mt-2">
            {pendingAction?.kind === "close-file"
              ? "保存该文件，或丢弃修改后关闭。"
              : `有 ${dirtyFiles.length} 个文件未保存，保存全部或丢弃修改后关闭编辑器。`}
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingAction(null)}>取消</Button>
            <Button variant="outline" onClick={discardAndRun}>丢弃</Button>
            <Button onClick={() => void saveAndRun()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
