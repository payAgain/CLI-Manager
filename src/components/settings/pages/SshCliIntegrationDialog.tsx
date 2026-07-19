import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowUp, ChevronRight, Copy, Download, FolderOpen, RefreshCw, RotateCcw, Save, Trash2, Undo2 } from "lucide-react";
import { buildSshConnectionSpec } from "../../../lib/ssh";
import { DEFAULT_SSH_TOOL_CONFIG_ROOT, validateSshToolConfigRoot } from "../../../lib/sshToolIntegration";
import type { SshAgentInstallPreview, SshAgentOperationResult, SshAgentProbeResult, SshHost, SshToolSource } from "../../../lib/types";
import { useI18n, type TranslationKey } from "../../../lib/i18n";
import { useSshAgentIntegrationStore } from "../../../stores/sshAgentIntegrationStore";
import { CliToolIcon } from "../../CliToolIcon";
import { Button } from "../../ui/button";
import { ConfirmDialog } from "../../ConfirmDialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../../ui/dialog";
import { Input } from "../../ui/input";

interface SshDirectoryEntry {
  name: string;
  path: string;
}

interface Props {
  open: boolean;
  host: SshHost | null;
  hosts: SshHost[];
  onOpenChange: (open: boolean) => void;
}

const SOURCES: SshToolSource[] = ["claude", "codex"];
const AGENT_STATUS_KEYS: Record<string, TranslationKey> = {
  notChecked: "settings.sshHosts.cliIntegration.agent.status.notChecked",
  installed: "settings.sshHosts.cliIntegration.agent.status.installed",
  notInstalled: "settings.sshHosts.cliIntegration.agent.status.notInstalled",
  incompatible: "settings.sshHosts.cliIntegration.agent.status.incompatible",
  corrupt: "settings.sshHosts.cliIntegration.agent.status.corrupt",
  unreachable: "settings.sshHosts.cliIntegration.agent.status.unreachable",
  unsupported: "settings.sshHosts.cliIntegration.agent.status.unsupported",
  authenticationRequired: "settings.sshHosts.cliIntegration.agent.status.authenticationRequired",
};
const AGENT_CODE_KEYS: Record<string, TranslationKey> = {
  ssh_agent_not_installed: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_not_installed",
  ssh_agent_protocol_incompatible: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_protocol_incompatible",
  ssh_agent_identity_invalid: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_identity_invalid",
  ssh_agent_authentication_required: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_authentication_required",
  unsupported_target: "settings.sshHosts.cliIntegration.agent.code.unsupported_target",
  ssh_agent_unreachable: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_unreachable",
  ssh_agent_probe_failed: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_probe_failed",
  ssh_agent_probe_output_too_large: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_probe_output_too_large",
  ssh_agent_probe_output_invalid: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_probe_output_invalid",
  ssh_agent_probe_magic_missing: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_probe_magic_missing",
  ssh_agent_probe_banner_too_large: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_probe_banner_too_large",
  ssh_agent_probe_stdout_contaminated: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_probe_stdout_contaminated",
  ssh_agent_probe_path_invalid: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_probe_path_invalid",
  ssh_agent_probe_magic_invalid: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_probe_magic_invalid",
  home_directory_unavailable: "settings.sshHosts.cliIntegration.agent.code.home_directory_unavailable",
  ssh_interactive_auth_required: "settings.sshHosts.cliIntegration.agent.code.ssh_interactive_auth_required",
  ssh_agent_manifest_signature_invalid: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_manifest_signature_invalid",
  ssh_agent_release_https_required: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_release_https_required",
  ssh_agent_release_target_missing: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_release_target_missing",
  ssh_agent_artifact_sha256_mismatch: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_artifact_sha256_mismatch",
  ssh_agent_artifact_size_mismatch: "settings.sshHosts.cliIntegration.agent.code.ssh_agent_artifact_size_mismatch",
  agent_install_locked: "settings.sshHosts.cliIntegration.agent.code.agent_install_locked",
  agent_downgrade_forbidden: "settings.sshHosts.cliIntegration.agent.code.agent_downgrade_forbidden",
  agent_launcher_conflict: "settings.sshHosts.cliIntegration.agent.code.agent_launcher_conflict",
  agent_install_root_mismatch: "settings.sshHosts.cliIntegration.agent.code.agent_install_root_mismatch",
  agent_previous_missing: "settings.sshHosts.cliIntegration.agent.code.agent_previous_missing",
};

const HTTP_INSTALL_SCRIPT_URL = "https://github.com/dark-hxx/CLI-Manager/releases/latest/download/install-ssh-agent.sh";

export function SshCliIntegrationDialog({ open, host, hosts, onOpenChange }: Props) {
  const { t } = useI18n();
  const preferences = useSshAgentIntegrationStore((state) => state.preferences);
  const installations = useSshAgentIntegrationStore((state) => state.installations);
  const fetchAll = useSshAgentIntegrationStore((state) => state.fetchAll);
  const saveHostPreferences = useSshAgentIntegrationStore((state) => state.saveHostPreferences);
  const recordAgentProbe = useSshAgentIntegrationStore((state) => state.recordAgentProbe);
  const recordAgentOperation = useSshAgentIntegrationStore((state) => state.recordAgentOperation);
  const [roots, setRoots] = useState<Record<SshToolSource, string>>({ claude: "", codex: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [pickerSource, setPickerSource] = useState<SshToolSource | null>(null);
  const [pickerPath, setPickerPath] = useState("/");
  const [directories, setDirectories] = useState<SshDirectoryEntry[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState("");
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<SshAgentProbeResult | null>(null);
  const [probeError, setProbeError] = useState("");
  const [agentInstallDir, setAgentInstallDir] = useState("");
  const [agentManifestUrl, setAgentManifestUrl] = useState("");
  const [allowHttp, setAllowHttp] = useState(false);
  const [agentOperation, setAgentOperation] = useState<"preview" | "install" | "rollback" | "uninstall" | null>(null);
  const [installPreview, setInstallPreview] = useState<SshAgentInstallPreview | null>(null);
  const [allowDowngrade, setAllowDowngrade] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"rollback" | "uninstall" | null>(null);
  const [scriptCopied, setScriptCopied] = useState(false);

  const hostPreferences = useMemo(() => {
    const result = new Map<SshToolSource, string>();
    if (!host) return result;
    for (const preference of preferences) {
      if (preference.host_id === host.id) result.set(preference.source, preference.configured_root);
    }
    return result;
  }, [host, preferences]);
  const installation = useMemo(
    () => host ? installations.find((item) => item.host_id === host.id) ?? null : null,
    [host, installations],
  );

  useEffect(() => {
    if (!open || !host) return;
    void fetchAll();
  }, [fetchAll, host, open]);

  useEffect(() => {
    if (!open || !host) return;
    setRoots({
      claude: hostPreferences.get("claude") ?? "",
      codex: hostPreferences.get("codex") ?? "",
    });
    setError("");
  }, [host, hostPreferences, open]);

  useEffect(() => {
    if (!open) return;
    setProbeResult(null);
    setProbeError("");
    setInstallPreview(null);
    setAllowDowngrade(false);
    setConfirmAction(null);
    setScriptCopied(false);
  }, [host?.id, open]);

  useEffect(() => {
    if (!open) return;
    setAgentInstallDir(installation?.install_root ?? "");
    setAgentManifestUrl(installation?.manifest_url ?? "");
  }, [installation?.host_id, installation?.install_root, installation?.manifest_url, open]);

  const agentErrorText = (value: unknown) => {
    const raw = String(value);
    const code = raw.split(":", 1)[0];
    return AGENT_CODE_KEYS[code]
      ? t(AGENT_CODE_KEYS[code])
      : t("settings.sshHosts.cliIntegration.agent.operationFailed", { code: raw });
  };

  const probeAgent = async () => {
    if (!host) return;
    setProbing(true);
    setProbeError("");
    try {
      const result = await invoke<SshAgentProbeResult>("ssh_agent_probe", {
        hostId: host.id,
        spec: buildSshConnectionSpec(host, hosts),
        agentPath: installation?.install_path || null,
      });
      await recordAgentProbe(host.id, result);
      setProbeResult(result);
    } catch (nextError) {
      setProbeError(agentErrorText(nextError));
    } finally {
      setProbing(false);
    }
  };

  const previewAgentInstall = async () => {
    if (!host) return;
    setAgentOperation("preview");
    setProbeError("");
    try {
      const preview = await invoke<SshAgentInstallPreview>("ssh_agent_install_preview", {
        hostId: host.id,
        spec: buildSshConnectionSpec(host, hosts),
        manifestUrl: agentManifestUrl.trim() || null,
        installDir: agentInstallDir.trim() || null,
        currentVersion: installation?.agent_version || null,
        allowHttp,
      });
      setInstallPreview(preview);
      setAllowDowngrade(false);
    } catch (nextError) {
      setProbeError(agentErrorText(nextError));
    } finally {
      setAgentOperation(null);
    }
  };

  const applyAgentResult = async (result: SshAgentOperationResult) => {
    if (!host) return;
    await recordAgentOperation(host.id, result);
    if (result.action === "uninstalled" || result.action === "purged") {
      setProbeResult({
        status: "notInstalled",
        code: "ssh_agent_not_installed",
        installPath: "",
        agentVersion: "",
        protocolVersion: "",
        target: "",
        supported: false,
        detail: "",
      });
      return;
    }
    setProbeResult({
      status: "installed",
      code: "ok",
      installPath: result.installPath,
      agentVersion: result.agentVersion,
      protocolVersion: result.protocolVersion,
      target: result.target,
      supported: true,
      detail: "",
    });
  };

  const installAgent = async () => {
    if (!host || !installPreview) return;
    setAgentOperation("install");
    setProbeError("");
    try {
      const result = await invoke<SshAgentOperationResult>("ssh_agent_install", {
        hostId: host.id,
        spec: buildSshConnectionSpec(host, hosts),
        manifestUrl: agentManifestUrl.trim() || null,
        installDir: agentInstallDir.trim() || null,
        allowHttp,
        allowDowngrade,
      });
      await applyAgentResult(result);
      setInstallPreview(null);
    } catch (nextError) {
      setProbeError(agentErrorText(nextError));
    } finally {
      setAgentOperation(null);
    }
  };

  const runAgentManagement = async (action: "rollback" | "uninstall") => {
    if (!host) return;
    setConfirmAction(null);
    setAgentOperation(action);
    setProbeError("");
    try {
      const result = await invoke<SshAgentOperationResult>(`ssh_agent_${action}`, {
        hostId: host.id,
        spec: buildSshConnectionSpec(host, hosts),
        agentPath: installation?.install_path || null,
        ...(action === "uninstall" ? { purge: false } : {}),
      });
      await applyAgentResult(result);
    } catch (nextError) {
      setProbeError(agentErrorText(nextError));
    } finally {
      setAgentOperation(null);
    }
  };

  const copyHttpInstallCommand = async () => {
    const command = `curl -fL -o install-ssh-agent.sh ${HTTP_INSTALL_SCRIPT_URL}\nless install-ssh-agent.sh\nsh install-ssh-agent.sh`;
    try {
      await navigator.clipboard.writeText(command);
      setScriptCopied(true);
    } catch (nextError) {
      setProbeError(agentErrorText(nextError));
    }
  };

  const loadDirectories = async (source: SshToolSource, path: string) => {
    if (!host) return;
    const normalizedPath = path.trim() || "/";
    setPickerSource(source);
    setPickerPath(normalizedPath);
    setPickerLoading(true);
    setPickerError("");
    try {
      const entries = await invoke<SshDirectoryEntry[]>("ssh_list_directories", {
        spec: buildSshConnectionSpec(host, hosts),
        path: normalizedPath,
      });
      setDirectories(entries);
    } catch (nextError) {
      setDirectories([]);
      setPickerError(String(nextError));
    } finally {
      setPickerLoading(false);
    }
  };

  const save = async () => {
    if (!host) return;
    for (const source of SOURCES) {
      const validationError = validateSshToolConfigRoot(roots[source]);
      if (validationError) {
        setError(t(`settings.sshHosts.cliIntegration.${validationError}` as TranslationKey));
        return;
      }
    }
    setSaving(true);
    setError("");
    try {
      await saveHostPreferences(host.id, roots);
      onOpenChange(false);
    } catch (nextError) {
      setError(String(nextError));
    } finally {
      setSaving(false);
    }
  };

  const reset = (source: SshToolSource) => {
    setRoots((current) => ({ ...current, [source]: "" }));
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-2xl overflow-y-auto p-0">
          <div className="border-b border-border px-5 py-4">
            <DialogTitle>{t("settings.sshHosts.cliIntegration.title", { name: host?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("settings.sshHosts.cliIntegration.description")}</DialogDescription>
          </div>
          <div className="space-y-5 px-5 py-4">
            <section className="space-y-3 border-b border-border pb-5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-text-primary">cli-manager-ssh-agent</h3>
                  <p className="text-xs text-text-muted">
                    {t(AGENT_STATUS_KEYS[probeResult?.status ?? installation?.status ?? "notChecked"] ?? AGENT_STATUS_KEYS.notChecked)}
                  </p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => void probeAgent()} disabled={probing}>
                  <RefreshCw className={`h-4 w-4 ${probing ? "animate-spin" : ""}`} />
                  {probing ? t("settings.sshHosts.cliIntegration.agent.probing") : t("settings.sshHosts.cliIntegration.agent.probe")}
                </Button>
              </div>
              {(probeResult?.agentVersion || installation?.agent_version) && (
                <div className="grid gap-2 text-xs text-text-muted sm:grid-cols-2">
                  <div>{t("settings.sshHosts.cliIntegration.agent.version", { value: probeResult?.agentVersion || installation?.agent_version || "-" })}</div>
                  <div>{t("settings.sshHosts.cliIntegration.agent.protocol", { value: probeResult?.protocolVersion || installation?.protocol_version || "-" })}</div>
                  <div>{t("settings.sshHosts.cliIntegration.agent.target", { value: probeResult?.target || installation?.target || "-" })}</div>
                  <div className="truncate font-mono" title={probeResult?.installPath || installation?.install_path || ""}>
                    {t("settings.sshHosts.cliIntegration.agent.path", { value: probeResult?.installPath || installation?.install_path || "-" })}
                  </div>
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="ui-config-form-label" htmlFor="ssh-agent-install-root">
                    {t("settings.sshHosts.cliIntegration.agent.installRoot")}
                  </label>
                  <Input
                    id="ssh-agent-install-root"
                    value={agentInstallDir}
                    onChange={(event) => setAgentInstallDir(event.target.value)}
                    placeholder="~/.local/share/cli-manager-ssh-agent"
                    className="font-mono text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <label className="ui-config-form-label" htmlFor="ssh-agent-manifest-url">
                    {t("settings.sshHosts.cliIntegration.agent.manifestUrl")}
                  </label>
                  <Input
                    id="ssh-agent-manifest-url"
                    value={agentManifestUrl}
                    onChange={(event) => setAgentManifestUrl(event.target.value)}
                    placeholder={t("settings.sshHosts.cliIntegration.agent.officialSource")}
                    className="font-mono text-sm"
                  />
                </div>
              </div>
              <label className="flex items-start gap-2 text-xs text-text-muted">
                <input
                  type="checkbox"
                  checked={allowHttp}
                  onChange={(event) => setAllowHttp(event.target.checked)}
                  className="mt-0.5"
                />
                <span>{t("settings.sshHosts.cliIntegration.agent.allowHttp")}</span>
              </label>
              <p className="text-xs text-text-muted">{t("settings.sshHosts.cliIntegration.agent.noHookChange")}</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={() => void previewAgentInstall()} disabled={agentOperation !== null}>
                  <Download className="h-4 w-4" />
                  {agentOperation === "preview" ? t("settings.sshHosts.cliIntegration.agent.preparing") : t("settings.sshHosts.cliIntegration.agent.previewInstall")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmAction("rollback")}
                  disabled={agentOperation !== null || !installation?.previous_version}
                >
                  <Undo2 className="h-4 w-4" />
                  {t("settings.sshHosts.cliIntegration.agent.rollback")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmAction("uninstall")}
                  disabled={agentOperation !== null || (probeResult?.status ?? installation?.status) !== "installed"}
                >
                  <Trash2 className="h-4 w-4" />
                  {t("settings.sshHosts.cliIntegration.agent.uninstall")}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => void copyHttpInstallCommand()}>
                  <Copy className="h-4 w-4" />
                  {scriptCopied ? t("settings.sshHosts.cliIntegration.agent.copied") : t("settings.sshHosts.cliIntegration.agent.copyScript")}
                </Button>
              </div>
              {probeResult?.code && probeResult.code !== "ok" && (
                <p className="text-xs text-warning">
                  {AGENT_CODE_KEYS[probeResult.code] ? t(AGENT_CODE_KEYS[probeResult.code]) : probeResult.code}
                </p>
              )}
              {(probeError || probeResult?.detail) && (
                <p className="break-words text-xs text-danger">{probeError || probeResult?.detail}</p>
              )}
            </section>
            {SOURCES.map((source) => (
              <section key={source} className="space-y-3 border-b border-border pb-5 last:border-b-0 last:pb-0">
                <div className="flex items-center gap-2">
                  <CliToolIcon icon={source === "claude" ? "claude-code" : "codex"} size={18} />
                  <h3 className="text-sm font-semibold text-text-primary">{source === "claude" ? "Claude" : "Codex"}</h3>
                </div>
                <label className="ui-config-form-label" htmlFor={`ssh-${source}-config-root`}>
                  {t("settings.sshHosts.cliIntegration.configRoot")}
                </label>
                <div className="flex gap-2">
                  <Input
                    id={`ssh-${source}-config-root`}
                    value={roots[source]}
                    onChange={(event) => setRoots((current) => ({ ...current, [source]: event.target.value }))}
                    placeholder={DEFAULT_SSH_TOOL_CONFIG_ROOT[source]}
                    className="min-w-0 flex-1 font-mono text-sm"
                  />
                  <Button type="button" variant="outline" size="sm" onClick={() => void loadDirectories(source, roots[source].startsWith("/") ? roots[source] : "/")}>
                    <FolderOpen className="h-4 w-4" />
                    {t("common.browse")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => reset(source)}
                    title={t("settings.sshHosts.cliIntegration.restoreDefault")}
                    aria-label={t("settings.sshHosts.cliIntegration.restoreDefault")}
                  >
                    <RotateCcw className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-xs text-text-muted">
                  {t("settings.sshHosts.cliIntegration.defaultPath", { path: DEFAULT_SSH_TOOL_CONFIG_ROOT[source] })}
                </p>
              </section>
            ))}
            {error && <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}
          </div>
          <DialogFooter className="border-t border-border px-5 py-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
            <Button type="button" onClick={() => void save()} disabled={saving}>
              <Save className="h-4 w-4" />
              {saving ? t("common.saving") : t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={installPreview !== null} onOpenChange={(nextOpen) => { if (!nextOpen && agentOperation !== "install") setInstallPreview(null); }}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-xl p-0" showCloseButton={agentOperation !== "install"}>
          <div className="border-b border-border px-5 py-4">
            <DialogTitle>{t("settings.sshHosts.cliIntegration.agent.previewTitle")}</DialogTitle>
            <DialogDescription>{t("settings.sshHosts.cliIntegration.agent.previewDescription")}</DialogDescription>
          </div>
          {installPreview && (
            <div className="grid gap-3 px-5 py-4 text-sm sm:grid-cols-2">
              <div><span className="text-text-muted">{t("settings.sshHosts.cliIntegration.agent.operation")}</span><div>{t(`settings.sshHosts.cliIntegration.agent.action.${installPreview.action}` as TranslationKey)}</div></div>
              <div><span className="text-text-muted">{t("settings.sshHosts.cliIntegration.agent.versionLabel")}</span><div>{installPreview.version}</div></div>
              <div><span className="text-text-muted">{t("settings.sshHosts.cliIntegration.agent.targetLabel")}</span><div>{installPreview.target}</div></div>
              <div><span className="text-text-muted">{t("settings.sshHosts.cliIntegration.agent.size")}</span><div>{(installPreview.artifactSize / 1024 / 1024).toFixed(1)} MB</div></div>
              <div className="sm:col-span-2"><span className="text-text-muted">{t("settings.sshHosts.cliIntegration.agent.installRoot")}</span><div className="break-all font-mono text-xs">{installPreview.installRoot}</div></div>
              <div className="sm:col-span-2"><span className="text-text-muted">SHA-256</span><div className="break-all font-mono text-xs">{installPreview.artifactSha256}</div></div>
              <div className="sm:col-span-2"><span className="text-text-muted">Manifest</span><div className="break-all font-mono text-xs">{installPreview.manifestUrl}</div></div>
              {installPreview.action === "downgrade" && (
                <label className="flex items-start gap-2 text-warning sm:col-span-2">
                  <input type="checkbox" checked={allowDowngrade} onChange={(event) => setAllowDowngrade(event.target.checked)} className="mt-0.5" />
                  <span>{t("settings.sshHosts.cliIntegration.agent.allowDowngrade")}</span>
                </label>
              )}
            </div>
          )}
          <DialogFooter className="border-t border-border px-5 py-4">
            <Button type="button" variant="outline" onClick={() => setInstallPreview(null)} disabled={agentOperation === "install"}>{t("common.cancel")}</Button>
            <Button type="button" onClick={() => void installAgent()} disabled={agentOperation === "install" || (installPreview?.action === "downgrade" && !allowDowngrade)}>
              <Download className="h-4 w-4" />
              {agentOperation === "install" ? t("settings.sshHosts.cliIntegration.agent.installing") : t("settings.sshHosts.cliIntegration.agent.confirmInstall")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmAction !== null}
        title={confirmAction === "rollback" ? t("settings.sshHosts.cliIntegration.agent.rollbackTitle") : t("settings.sshHosts.cliIntegration.agent.uninstallTitle")}
        message={confirmAction === "rollback" ? t("settings.sshHosts.cliIntegration.agent.rollbackMessage") : t("settings.sshHosts.cliIntegration.agent.uninstallMessage")}
        confirmText={confirmAction === "rollback" ? t("settings.sshHosts.cliIntegration.agent.rollback") : t("settings.sshHosts.cliIntegration.agent.uninstall")}
        cancelText={t("common.cancel")}
        danger={confirmAction === "uninstall"}
        zIndex={80}
        onClose={() => setConfirmAction(null)}
        onConfirm={() => { if (confirmAction) void runAgentManagement(confirmAction); }}
      />

      <Dialog open={pickerSource !== null} onOpenChange={(nextOpen) => { if (!nextOpen) setPickerSource(null); }}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-xl p-0">
          <div className="border-b border-border px-4 py-3">
            <DialogTitle>{t("settings.sshHosts.cliIntegration.pickerTitle")}</DialogTitle>
            <DialogDescription className="sr-only">{t("settings.sshHosts.cliIntegration.pickerDescription")}</DialogDescription>
          </div>
          <div className="space-y-3 p-4">
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => {
                const parent = pickerPath.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
                if (pickerSource) void loadDirectories(pickerSource, parent);
              }} title={t("common.parentDirectory")} aria-label={t("common.parentDirectory")}>
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Input value={pickerPath} onChange={(event) => setPickerPath(event.target.value)} className="flex-1 font-mono text-sm" />
              <Button type="button" variant="outline" onClick={() => { if (pickerSource) void loadDirectories(pickerSource, pickerPath); }}>{t("common.refresh")}</Button>
            </div>
            <div className="max-h-72 min-h-48 overflow-y-auto rounded-md border border-border p-1">
              {pickerLoading && <div className="p-4 text-sm text-text-muted">{t("common.loading")}</div>}
              {!pickerLoading && pickerError && <div className="p-4 text-sm text-danger">{pickerError}</div>}
              {!pickerLoading && !pickerError && directories.map((entry) => (
                <button key={entry.path} type="button" onClick={() => setPickerPath(entry.path)} onDoubleClick={() => { if (pickerSource) void loadDirectories(pickerSource, entry.path); }} className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm hover:bg-surface-container-highest">
                  <span className="truncate">{entry.name}</span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
                </button>
              ))}
            </div>
          </div>
          <DialogFooter className="border-t border-border px-4 py-3">
            <Button type="button" variant="outline" onClick={() => setPickerSource(null)}>{t("common.cancel")}</Button>
            <Button type="button" onClick={() => {
              if (pickerSource) setRoots((current) => ({ ...current, [pickerSource]: pickerPath.trim() || "/" }));
              setPickerSource(null);
            }}>{t("configModal.ssh.selectCurrentDirectory")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
