import { useState } from "react";
import { X } from "lucide-react";
import { useT } from "../lib/i18n.ts";
import type { EnrollmentState } from "../lib/relay/device.ts";
import type { EnrollmentCompletion, EnrollmentReplacement } from "../lib/relay/shellState.ts";

export function EnrollmentStatus({ state, pc, retry }: { readonly state: EnrollmentState | "local" | EnrollmentCompletion | EnrollmentReplacement | undefined; readonly pc: string; readonly retry?: () => void }) {
  const t = useT();
  const [hidden, setHidden] = useState(false);
  // the fingerprint this device computed for its new key, never one the PC sent: the person compares it with the PC's screen
  // Dismiss hides the card here only: the PC's screen still decides, and nothing is sent
  if (typeof state === "object" && "kind" in state) return hidden ? null : <div role="status" data-replacement={state.fingerprint}><button type="button" className="icon-button update-notice-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={() => setHidden(true)}><X /></button><p className="relay-shell-detail">{t("Approve this device on {pc}'s screen", { pc })}</p><p className="relay-shell-detail"><strong>{state.fingerprint}</strong></p></div>;
  if (typeof state === "object") return <p className="relay-shell-detail" role="status">{t("In your account")}{state.admitted !== undefined && <> · {t("Devices added: {count}", { count: state.admitted })}</>}</p>;
  switch (state) {
    case "pending": return <div className="relay-shell-wait" role="status"><span className="boot-spinner" aria-hidden="true" /><p className="relay-shell-detail">{t("Adding it to your account…")}</p></div>;
    case "complete": return <p className="relay-shell-detail" role="status">{t("In your account")}</p>;
    case "failed": return <div role="status"><p className="relay-shell-detail">{t("Account setup is incomplete.")}</p>{retry && <button type="button" className="btn" data-action="retry-enrollment" onClick={retry}>{t("Try again")}</button>}</div>;
    case "local": case undefined: return null;
  }
}
