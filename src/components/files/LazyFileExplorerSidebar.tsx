import { lazy, Suspense } from "react";
import type { FileExplorerSidebarProps } from "./FileExplorerSidebar";

const FileExplorerContent = lazy(() => import("./FileExplorerSidebar")
  .then((module) => ({ default: module.FileExplorerSidebar })));

export function FileExplorerSidebar(props: FileExplorerSidebarProps) {
  return <Suspense fallback={null}><FileExplorerContent {...props} /></Suspense>;
}
