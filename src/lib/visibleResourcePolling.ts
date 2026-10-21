/** One polling lifetime. Disposed requests cannot publish into a reopened view. */
export function createVisibleResourcePoller<T>(options: {
  isVisible: () => Promise<boolean>;
  read: () => Promise<T>;
  onSnapshot: (snapshot: T) => void;
  onError: (error: unknown) => void;
  onLoading: (loading: boolean) => void;
}) {
  let disposed = false;
  let pending = false;
  return {
    async refresh(showLoading = false) {
      if (disposed || pending) return;
      pending = true;
      try {
        if (!await options.isVisible() || disposed) return;
        if (showLoading) options.onLoading(true);
        const snapshot = await options.read();
        if (!disposed) options.onSnapshot(snapshot);
      } catch (error) {
        if (!disposed) options.onError(error);
      } finally {
        pending = false;
        if (!disposed) options.onLoading(false);
      }
    },
    dispose() { disposed = true; },
  };
}
