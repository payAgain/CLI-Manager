import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Github, Terminal } from "lucide-react";
import { useI18n } from "../../lib/i18n";

const REPOSITORY_URL = "https://github.com/payAgain/CLI-Manager";
const UPSTREAM_URL = "https://github.com/dark-hxx/CLI-Manager";

export function AboutSection() {
  const { t } = useI18n();
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    void invoke<{ version: string }>("get_app_version")
      .then((result) => {
        if (!disposed) setVersion(result.version);
      })
      .catch(() => {});
    return () => { disposed = true; };
  }, []);

  return (
    <div className="space-y-4">
      <section className="ui-surface-card rounded-2xl border border-border p-5">
        <div className="flex items-center gap-3">
          <Terminal className="h-8 w-8 text-primary" aria-hidden="true" />
          <div>
            <h2 className="text-lg font-semibold text-on-surface">CLI-Manager</h2>
            <p className="text-sm text-on-surface-variant">
              {t("about.lean.version", { version: version ?? "—" })}
            </p>
          </div>
        </div>
        <p className="mt-4 text-sm leading-6 text-on-surface-variant">{t("about.lean.description")}</p>
        <p className="mt-2 text-xs leading-5 text-on-surface-variant">{t("about.lean.releasePolicy")}</p>
      </section>
      {[
        { url: REPOSITORY_URL, label: t("about.lean.repository"), icon: Github },
        { url: UPSTREAM_URL, label: t("about.lean.upstream"), icon: ExternalLink },
      ].map(({ url, label, icon: Icon }) => (
        <button
          key={url}
          type="button"
          onClick={() => void openUrl(url).catch(() => {})}
          className="ui-interactive ui-focus-ring flex w-full items-center gap-3 rounded-xl border border-border p-4 text-left text-sm text-on-surface hover:bg-surface-container-high"
        >
          <Icon size={16} aria-hidden="true" />
          {label}
          <ExternalLink size={13} className="ml-auto text-on-surface-variant" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
