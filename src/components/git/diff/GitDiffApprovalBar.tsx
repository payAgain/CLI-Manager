import { useEffect, useRef, useState } from "react";
import { Check, RefreshCw, RotateCcw } from "lucide-react";
import { fingerprintGitDiff, getGitDiffApprovalStatus } from "../../../lib/gitDiffApproval";
import { useI18n } from "../../../lib/i18n";
import { useGitDiffApprovalStore } from "../../../stores/gitDiffApprovalStore";
import type { GitDiffController, GitDiffLiveDataSource, GitDiffTarget } from "./types";

interface Props {
  approvalKey: string;
  target: GitDiffTarget;
  dataSource: GitDiffLiveDataSource;
  controller: GitDiffController;
  exact: boolean;
  onNextPending?: () => void;
  onApproved?: () => void;
}

export function GitDiffApprovalBar({ approvalKey, target, dataSource, controller, exact, onNextPending, onApproved }: Props) {
  const { t } = useI18n();
  const record = useGitDiffApprovalStore((state) => state.records[approvalKey]);
  const observedFingerprint = useGitDiffApprovalStore((state) => state.fingerprints[approvalKey]);
  const loaded = useGitDiffApprovalStore((state) => state.loaded);
  const [busy, setBusy] = useState(false);
  const [viewFingerprint, setViewFingerprint] = useState<string | null>(null);
  const [error, setError] = useState<"changed" | "storage" | "load" | null>(null);
  const generation = useRef(0);
  const supported = controller.reviewVersion === 1;
  const eligible = supported && exact && !controller.loading && !controller.error && Boolean(controller.parsed?.file.hunks.length);
  // Another pane may load this file too. Never approve its newer snapshot on behalf of this view.
  const fingerprint = observedFingerprint === viewFingerprint ? viewFingerprint : null;
  const status = getGitDiffApprovalStatus(record, fingerprint);

  useEffect(() => {
    const current = ++generation.current;
    const store = useGitDiffApprovalStore.getState();
    store.observe(approvalKey, null);
    setViewFingerprint(null);
    setBusy(false);
    void store.load().catch(() => { if (current === generation.current) setError("storage"); });
    if (eligible) {
      void fingerprintGitDiff(controller.diffText, controller.contentFingerprint).then((value) => {
        if (current === generation.current) { setViewFingerprint(value); store.observe(approvalKey, value); }
      }).catch(() => { if (current === generation.current) setError("load"); });
    }
    return () => { generation.current++; };
  }, [approvalKey, controller.diffText, controller.contentFingerprint, eligible, dataSource]);

  const approve = async (next: boolean) => {
    if (!eligible || !fingerprint || busy || !loaded) return;
    const current = generation.current;
    const expected = fingerprint;
    let saving = false;
    setBusy(true); setError(null);
    try {
      const latest = await dataSource.load(target);
      const actual = latest.reviewVersion === 1 ? await fingerprintGitDiff(latest.content, latest.contentFingerprint) : null;
      if (current !== generation.current) return;
      useGitDiffApprovalStore.getState().observe(approvalKey, actual);
      if (actual !== expected) {
        setError("changed"); controller.reload(); return;
      }
      saving = true;
      await useGitDiffApprovalStore.getState().approve(approvalKey, expected);
      if (current === generation.current) {
        if (next) onNextPending?.();
        else onApproved?.();
      }
    } catch (failure) {
      if (current === generation.current) {
        setError(String(failure).includes("git_diff_approval_changed") ? "changed" : saving ? "storage" : "load");
        useGitDiffApprovalStore.getState().observe(approvalKey, null);
      }
    } finally { if (current === generation.current) setBusy(false); }
  };

  const revoke = async () => {
    const current = generation.current;
    setBusy(true); setError(null);
    try { await useGitDiffApprovalStore.getState().revoke(approvalKey); }
    catch { if (current === generation.current) setError("storage"); }
    finally { if (current === generation.current) setBusy(false); }
  };

  return <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 bg-surface-container-low px-3 py-2 font-sans text-xs" data-git-diff-approval>
    <span className={status === "changed" ? "text-warning" : "text-text-secondary"} role="status">
      {t(`git.approval.${status}`)}
    </span>
    <span className="min-w-0 flex-[1_1_16rem] text-text-muted">
      {error ? t(`git.approval.error.${error}`) : !controller.loading && !controller.error && !supported ? t("git.approval.upgradeRequired") : !exact ? t("git.approval.exactRequired")
        : !controller.loading && !fingerprint ? t("git.approval.unavailable") : t("git.approval.localOnly")}
    </span>
    {(error || status === "unverified") && <button type="button" className="ui-focus-ring flex items-center gap-1 rounded px-2 py-1 text-text-secondary hover:bg-surface-container-high disabled:opacity-50" disabled={busy || controller.loading} onClick={() => { setError(null); controller.reload(); }}>
      <RefreshCw size={13} />{t("git.approval.refresh")}
    </button>}
    {record && <button type="button" className="ui-focus-ring flex items-center gap-1 rounded px-2 py-1 text-text-secondary hover:bg-surface-container-high disabled:opacity-50" disabled={busy} onClick={() => void revoke()}>
      <RotateCcw size={13} />{t("git.approval.revoke")}
    </button>}
    {status !== "approved" && <button type="button" className="ui-button-primary ui-focus-ring flex items-center gap-1 rounded px-2 py-1 disabled:opacity-50" disabled={!eligible || !fingerprint || !loaded || busy} onClick={() => void approve(false)}>
      <Check size={13} />{busy ? t("git.approval.verifying") : t("git.approval.approve")}
    </button>}
    {onNextPending && <button type="button" className="ui-focus-ring rounded px-2 py-1 text-text-secondary hover:bg-surface-container-high disabled:opacity-50" disabled={busy || (status !== "approved" && (!eligible || !fingerprint || !loaded))} onClick={() => status === "approved" ? onNextPending() : void approve(true)}>
      {t(status === "approved" ? "git.approval.nextPending" : "git.approval.approveNext")}
    </button>}
  </div>;
}
