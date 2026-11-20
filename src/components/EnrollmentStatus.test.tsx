import { expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsProvider } from "../lib/settings.ts";
import { translate } from "../lib/i18n.ts";
import { createShellTestPage } from "../lib/relay/shell.test.tsx";
import { EnrollmentStatus } from "./EnrollmentStatus.tsx";

it("reports account enrollment without promising access for every account device", () => {
  const browser = createShellTestPage();
  try {
    const markup = renderToStaticMarkup(<SettingsProvider><EnrollmentStatus state="complete" pc="Desk" /></SettingsProvider>);
    expect(markup).toContain("In your account");
    expect(markup).not.toContain("Every device");
  } finally { browser.dispose(); }
});

it.each(["en", "ko", "ja", "zh"] as const)("renders only confirmed admission counts in %s", (language) => {
  const browser = createShellTestPage();
  try {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: [language] } });
    for (const admitted of [0, 1, 2]) {
      const markup = renderToStaticMarkup(<SettingsProvider><EnrollmentStatus state={{ state: "complete", admitted }} pc="Desk" /></SettingsProvider>);
      expect(markup).toContain(translate(language, "In your account"));
      expect(markup).toContain(translate(language, "Devices added: {count}", { count: admitted }));
    }
  } finally { browser.dispose(); }
});

it.each(["en", "ko", "ja", "zh"] as const)("P22/T72: a link the PC holds for its screen shows this device's own fingerprint, whole, beside the PC's name in %s", (language) => {
  const browser = createShellTestPage();
  try {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: [language] } });
    const markup = renderToStaticMarkup(<SettingsProvider><EnrollmentStatus state={{ kind: "replacement", fingerprint: "AB12-CD34" }} pc="Desk" /></SettingsProvider>);
    expect(markup.replaceAll("&#x27;", "'")).toContain(translate(language, "Approve this device on {pc}'s screen", { pc: "Desk" }));
    expect(markup).toContain(">AB12-CD34<");
  } finally { browser.dispose(); }
});
