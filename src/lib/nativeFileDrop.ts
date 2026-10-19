/** Native file drops are broadcast to every listener in the webview. */
export function isNativeFileDropTarget(
  container: HTMLElement | null,
  x: number,
  y: number,
): boolean {
  if (!container || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  const target = container.ownerDocument.elementFromPoint(x, y);
  return target !== null && container.contains(target);
}
