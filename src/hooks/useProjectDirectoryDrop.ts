import { useEffect, useRef, useState, type RefObject } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isNativeFileDropTarget } from "../lib/nativeFileDrop";
import { logError } from "../lib/logger";

interface ProjectDirectoryDropTarget {
  treeKey: string | null;
}

interface ProjectDirectoryDropOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  onDrop: (paths: string[], treeKey: string | null) => Promise<void>;
}

export function useProjectDirectoryDrop(options: ProjectDirectoryDropOptions) {
  const latest = useRef(options);
  latest.current = options;
  const [target, setTarget] = useState<ProjectDirectoryDropTarget | null>(null);

  useEffect(() => {
    if (!options.enabled || !("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let sequence = 0;
    let hasPaths = false;
    let imports = Promise.resolve();
    const clearTarget = () => {
      sequence += 1;
      setTarget(null);
    };
    window.addEventListener("blur", clearTarget);
    void getCurrentWebview().onDragDropEvent(async ({ payload }) => {
      const eventSequence = ++sequence;
      if (disposed) return;
      if (payload.type === "leave") {
        hasPaths = false;
        setTarget(null);
        return;
      }
      if (payload.type === "enter" || payload.type === "drop") hasPaths = payload.paths.length > 0;
      if (!hasPaths) return;
      const scale = await getCurrentWindow().scaleFactor().catch(() => window.devicePixelRatio || 1);
      if (disposed || !latest.current.enabled) return;
      const point = payload.position.toLogical(scale);
      const container = latest.current.containerRef.current;
      const inside = isNativeFileDropTarget(container, point.x, point.y);
      const hit = inside ? container!.ownerDocument.elementFromPoint(point.x, point.y) : null;
      const treeKey = hit?.closest<HTMLElement>("[data-tree-key]")?.dataset.treeKey ?? null;
      if (payload.type !== "drop") {
        if (eventSequence === sequence) setTarget(inside ? { treeKey } : null);
        return;
      }
      hasPaths = false;
      setTarget(null);
      if (!inside) return;
      const onDrop = latest.current.onDrop;
      imports = imports.then(() => onDrop(payload.paths, treeKey))
        .catch((error) => logError("Failed to import dropped project folders", error));
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    }).catch((error) => logError("Failed to listen for project folder drops", error));
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("blur", clearTarget);
      setTarget(null);
    };
  }, [options.enabled]);

  return target;
}
