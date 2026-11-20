import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAccountDevicesFile } from "../../shared/account-snapshot.ts";
import { TestClock } from "../relay/test-helpers.ts";
import { ACCOUNT_DEVICES_FILE, type DropReason } from "./account-devices.ts";
import { listOrigins, SERVER, snapshotList } from "./account-devices.test-helpers.ts";
import { accountRowsFor } from "./account-row-source.ts";
import { DeviceJournal } from "./device-journal.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { listNotices } from "./list-notices.ts";
import { RemovalEvidence } from "./removal-evidence.ts";
import { SafetyLog } from "./safety-log.ts";

test("P9/T54 ledger: a backward wall-clock step at the expiry deadline does not keep the session past deadline + step; the timer re-checks on a monotonic interval", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ledger-expiry-"));
  const elapsed = new TestClock();
  const start = Date.UTC(2026, 0, 1, 12);
  const deadline = Date.UTC(2026, 2, 2) - start; // Midnight UTC on the 60th day.
  const step = 3_000;
  let wallOffset = 0;
  const closes: { readonly id: string; readonly reason: DropReason; readonly at: number }[] = [];
  const safety = SafetyLog.open(stateDir);
  const journal = DeviceJournal.open(stateDir, () => safety.ensureFile());
  const evidence = RemovalEvidence.open(stateDir, safety);
  const source = accountRowsFor(stateDir, () => SERVER, {
    evidence,
    ...listNotices(journal, evidence, () => {}),
    closeSessions: (id, reason) => { closes.push({ id, reason, at: elapsed.now() }); },
    heldByDevicesJson: () => false,
    admits: () => true,
    now: () => start + elapsed.now() + wallOffset,
    setTimeout: (run, ms) => elapsed.setTimeout(run, ms),
    admitOrigin: listOrigins(),
    firstDevice: { othersEver: () => true, setOthersEver: () => {}, listKey: () => null, otherRows: () => false },
  });
  try {
    source.store()?.commitList(snapshotList(["Laptop"]));
    const [row] = source.rows();
    if (!row) throw new Error("Missing listed row");
    elapsed.advance(JOIN_HOLD_MS);
    expect(source.access(row.id)).toEqual({ ok: true });
    source.seen(row.id);

    elapsed.advance(deadline - elapsed.now() - 1);
    wallOffset -= step;
    elapsed.advance(1);

    const saved = parseAccountDevicesFile(JSON.parse(readFileSync(join(stateDir, ACCOUNT_DEVICES_FILE), "utf8")));
    const drops = DeviceJournal.open(stateDir).entries()
      .filter(entry => entry.kind === "drop" && entry.row === row.id)
      .map(entry => entry.how);
    expect({ state: saved.devices.find(device => device.id === row.id)?.state, closes, drops }).toEqual({
      state: "expired",
      closes: [{ id: row.id, reason: "expired", at: deadline }],
      drops: ["expired"],
    });
  } finally {
    source.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
