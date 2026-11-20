import { useT } from "../lib/i18n.ts";
import type { EnrollmentState } from "../lib/relay/device.ts";
import type { EnrollmentCompletion, EnrollmentReplacement } from "../lib/relay/shellState.ts";

export function EnrollmentStatus({ state, pc, retry }: { readonly state: EnrollmentState | "local" | EnrollmentCompletion | EnrollmentReplacement | undefined; readonly pc: string; readonly retry?: () => void }) {
  const t = useT();
  // the fingerprint this device computed for its new key, never one the PC sent: the person compares it with the PC's screen
  if (typeof state === "object" && "kind" in state) return <p className="relay-shell-detail" role="status" data-replacement={state.fingerprint}>{t("Approve this device on {pc}'s screen", { pc })}<strong className="relay-shell-fingerprint">{state.fingerprint}</strong></p>;
  if (typeof state === "object") return <p className="relay-shell-detail" role="status">{t("In your account")}{state.admitted !== undefined && <> · {t("Devices added: {count}", { count: state.admitted })}</>}</p>;
  switch (state) {
    case "pending": return <div className="relay-shell-wait" role="status"><span className="boot-spinner" aria-hidden="true" /><p className="relay-shell-detail">{t("Adding it to your account…")}</p></div>;
    case "complete": return <p className="relay-shell-detail" role="status">{t("In your account")}</p>;
    case "failed": return <div role="status"><p className="relay-shell-detail">{t("Account setup is incomplete.")}</p>{retry && <button type="button" className="btn" data-action="retry-enrollment" onClick={retry}>{t("Try again")}</button>}</div>;
    case "local": case undefined: return null;
  }
}
