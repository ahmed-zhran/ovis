import { afterEach, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { newRecordId, signAccountRecord } from "../../shared/account-records.ts";
import { ACCOUNT_OPENS_ALL_FEATURE, FrameType } from "../../shared/relay-mux.ts";
import * as privateState from "../private-state.ts";
import { bounded, relayConnection, relayFixture, TestClock } from "../relay/test-helpers.ts";
import { ACCOUNT_DEVICES_FILE } from "./account-devices.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { ACCOUNT, createListedPc } from "./listed-pc.test-helpers.ts";
import { applyAccountRecords } from "./records.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

test("T42/E39 ledger: a promoted row's 10 s hold starts at the committed write, not at a failed attempt", async () => {
  const clock = new TestClock();
  const epoch = Date.UTC(2026, 10, 20);
  const wall = spyOn(Date, "now").mockImplementation(() => epoch + clock.now());
  closes.push(() => wall.mockRestore());
  const pc = await createListedPc(close => closes.push(close), clock);
  const before = pc.fixture.app.context.services;
  const add = await signAccountRecord({ v: 1, kind: "add", account: ACCOUNT,
    key: pc.device.publicKey, signer: pc.member.publicKey, label: "Promoted laptop", role: "watch",
    issued_at: new Date(Date.now()).toISOString(), id: newRecordId() }, pc.member.keys.privateKey);
  expect(await applyAccountRecords(before.devices, [add], pc.serverId)).toMatchObject([{ outcome: "applied" }]);
  expect(before.devices.hasKey(pc.device.publicKey)).toBe(true);
  expect(before.devices.sessionRow(pc.device.id)).toBeNull();
  pc.fixture.app.stop();
  clock.advance(20_000);
  pc.service.opensAll = false;
  const restarted = relayFixture(false, { stateDir: pc.fixture.stateDir, accountOpensAll: true,
    accountService: { url: "https://account.test", fetch: pc.service.fetch } });
  closes.push(() => {
    for (const close of restarted.closes) close();
    restarted.app.stop();
  });
  const { devices, accountMailbox } = restarted.app.context.services;
  devices.useClock(clock);
  await accountMailbox.pull();
  const write = privateState.writePrivateState;
  let failedListWrite = false;
  const fault = spyOn(privateState, "writePrivateState").mockImplementation((path, value) => {
    if (path === join(pc.fixture.stateDir, ACCOUNT_DEVICES_FILE) && !failedListWrite) {
      failedListWrite = true;
      throw new Error("Ledger injected account list write failure");
    }
    return write(path, value);
  });
  closes.push(() => fault.mockRestore());
  pc.service.opensAll = true;
  expect(await accountMailbox.readSnapshot()).toBeNull();
  expect(failedListWrite).toBe(true);
  expect(devices.sessionRow(pc.device.id)).toBeNull();
  fault.mockRestore();

  clock.advance(1_000);
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const committedAt = Date.now();
  const held = await relayConnection(restarted, { serverId: pc.serverId });
  let hold: unknown;
  held.onFrame = frame => { if (frame.type === FrameType.SESSION_ERROR) hold = frame.payload.hold; };
  void held.auth(pc.device, [ACCOUNT_OPENS_ALL_FEATURE]).catch(() => undefined);
  expect(await bounded(held.serverError)).toBe("held");
  expect(hold).toEqual({ reason: "join_hold", until: new Date(committedAt + JOIN_HOLD_MS).toISOString() });
  clock.advance(JOIN_HOLD_MS - 1);
  expect(devices.sessionRow(pc.device.id)).toBeNull();
  clock.advance(1);
  expect(devices.sessionRow(pc.device.id)).toMatchObject({ role: "watch", key: pc.device.publicKey });
});
