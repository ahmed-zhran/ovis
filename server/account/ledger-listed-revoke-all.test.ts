import { expect, onTestFinished, test } from "bun:test";
import { DeviceJournal } from "./device-journal.ts";
import { createListedPc } from "./listed-pc.test-helpers.ts";

test("P24/T70: Revoke all journals the local actor on listed-row drops", async () => {
  const { fixture, device } = await createListedPc(onTestFinished);
  const { devices } = fixture.app.context.services;
  expect(devices.has(device.id)).toBe(true);

  devices.revokeAll("alice");

  const listedDrops = DeviceJournal.open(fixture.stateDir).entries()
    .filter(entry => entry.row === device.id && entry.kind === "drop");
  expect(listedDrops.map(entry => entry.by)).toEqual(["alice"]);
});
