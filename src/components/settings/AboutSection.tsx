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
    <div className="ui-about">
      <section>
        <div className="ui-about-identity">
          <Terminal size={30} strokeWidth={1.35} aria-hidden="true" />
          <div>
            <h2>CLI-Manager</h2>
            <p className="ui-about-version">
              {t("about.lean.version", { version: version ?? "—" })}
            </p>
          </div>
        </div>
        <p className="ui-about-description">{t("about.lean.description")}</p>
        <p className="ui-about-policy">{t("about.lean.releasePolicy")}</p>
      </section>
      {[
        { url: REPOSITORY_URL, label: t("about.lean.repository"), icon: Github },
        { url: UPSTREAM_URL, label: t("about.lean.upstream"), icon: ExternalLink },
      ].map(({ url, label, icon: Icon }) => (
        <button
          key={url}
          type="button"
          onClick={() => void openUrl(url).catch(() => {})}
          className="ui-about-link ui-focus-ring"
        >
          <Icon size={16} aria-hidden="true" />
          {label}
          <ExternalLink size={13} className="ml-auto text-on-surface-variant" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
