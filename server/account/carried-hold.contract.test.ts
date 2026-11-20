import { afterEach, expect, spyOn, test } from "bun:test";
import { newRecordId, signAccountRecord } from "../../shared/account-records.ts";
import { relayDevice } from "../relay/test-helpers.ts";
import { ACCOUNT, createListedPc } from "./listed-pc.test-helpers.ts";
import { phone } from "./pairing.test-helpers.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });

async function listedTablet() {
  const { fixture, service, serverId, member: elder } = await createListedPc(close => closes.push(close));
  const time = { now: Date.now() + 3_600_001 };
  const clock = spyOn(Date, "now").mockImplementation(() => time.now);
  closes.push(() => clock.mockRestore());
  const { devices, accountMailbox } = fixture.app.context.services;
  const recent = await relayDevice(fixture);
  devices.linkAccountKey(recent.id, recent.publicKey, recent.publicKey, ACCOUNT);
  const { spki: key } = await phone();
  service.registerDevice(ACCOUNT, key, "Tablet");
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const notice = devices.openNotices().find(n => n.key === key);
  if (!notice?.row) throw new Error("Expected the tablet admission");
  const id = notice.row;
  const approve = (addedBy: string) => devices.pairRelayApproved("Tablet", key, { path: "account", addedBy, id });
  async function signedAdd(member: typeof elder) {
    const record = await signAccountRecord({ v: 1, kind: "add", account: ACCOUNT, key, signer: member.publicKey,
      label: "Tablet", role: "drive", issued_at: new Date(time.now).toISOString(), id: newRecordId() }, member.keys.privateKey);
    expect((await service.fetch(new Request("https://account.test/v1/records", { method: "POST",
      headers: { authorization: `Bearer ${service.issueToken(ACCOUNT)}` }, body: JSON.stringify({ server_ids: [serverId], record }) }))).ok).toBe(true);
    await accountMailbox.pull();
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  }
  return { devices, elder, recent, approve, signedAdd, time, id, key, notice: notice.id };
}

async function recentlyPromoted() {
  const tablet = await listedTablet();
  expect(tablet.approve(tablet.recent.id)?.device.id).toBe(tablet.id);
  expect(tablet.devices.sessionRow(tablet.id)).toBeNull();
  tablet.time.now++;
  return tablet;
}

test.each([
  ["recent", "signed add"], ["recent", "digits"],
  ["established", "signed add"], ["established", "digits"],
] as const)("H1/T38, P15/T57: %s member's %s affects the hold but leaves the notice answerable", async (standing, method) => {
  const { devices, elder, recent, approve, signedAdd, id, key, notice } =
    standing === "established" ? await recentlyPromoted() : await listedTablet();
  const member = standing === "established" ? elder : recent;
  if (method === "signed add") await signedAdd(member);
  else expect(approve(member.id)?.device.id).toBe(id);
  expect(devices.originOf(id)?.how).toBe("promoted");
  if (standing === "established") expect(devices.sessionRow(id)).toMatchObject({ role: "drive", key });
  else expect(devices.sessionRow(id)).toBeNull();
  const replay = () => devices.noticeReplay(elder.id)?.notices.find(n => n.id === notice);
  expect(replay()?.open).toBe(true);
  expect(devices.itsMe(elder.id, notice, elder.publicKey)).toBe(true);
  expect(replay()?.open).toBe(false);
  expect(devices.sessionRow(id)).toMatchObject({ role: "drive", key });
});

test.each(["held", "timer released"] as const)("P15/T57/P22: the screen confirms the %s promoted key and decides its notice", async state => {
  const { devices, elder, time, id, key, notice } = await recentlyPromoted();
  if (state === "timer released") {
    time.now += 10_000;
    expect(devices.sessionRow(id)).toMatchObject({ role: "drive", key });
  }
  const replay = () => devices.noticeReplay(elder.id)?.notices;
  expect(replay()?.find(n => n.id === notice)?.open).toBe(true);
  const reservation = devices.redeemCode(devices.startPairing().code, "code", key);
  if (!reservation.ok) throw new Error(`Code reservation failed: ${reservation.reason}`);
  expect(devices.admitConfirmed({ codeId: reservation.codeId, key, label: "Tablet", source: "screen" })?.id).toBe(id);
  expect(devices.originOf(id)?.from).toBe("pc");
  expect(devices.sessionRow(id)).toMatchObject({ role: "drive", key });
  expect(replay()?.find(n => n.id === notice)?.open).toBe(false);
  expect(replay()?.filter(n => n.kind === "confirm" && n.key === key)).toMatchObject([{ row: id, how: "confirmed", by: "pc" }]);
  expect(devices.itsMe(elder.id, notice, elder.publicKey)).toBe(false);
});
