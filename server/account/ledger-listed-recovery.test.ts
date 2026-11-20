import { expect, onTestFinished, test } from "bun:test";
import { createListedPc } from "./listed-pc.test-helpers.ts";

test("T70: local recovery removes a listed row by its ID", async () => {
  const { fixture, device } = await createListedPc(onTestFinished);
  const { devices } = fixture.app.context.services;
  expect(devices.has(device.id)).toBe(true);

  const result = devices.removeKey({ target: device.id, by: "local", user: "alice" });

  expect(result).toEqual({ removed: [device.id] });
});
