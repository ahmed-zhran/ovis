/**
 * Ledger item H1 of S2-18 (#4302): a lock or unlock is reported applied although the folder holding the safety log
 * could not be synced after the write, so a power loss may take the record back while the screen said it was done.
 * Fails today; must pass before S2-38.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { fstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateStateFs } from "../private-state.ts";
import { SafetyLog } from "./safety-log.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function failingDirectorySync() {
  const real = privateStateFs.fsyncSync;
  return spyOn(privateStateFs, "fsyncSync").mockImplementation(((fd: number) => {
    if (fstatSync(fd).isDirectory()) throw Object.assign(new Error("EIO"), { code: "EIO" });
    real(fd);
  }) as never);
}

test("H1/P24: a lock whose folder could not be synced is not reported applied", () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-ledger-h1-"));
  dirs.push(dir);
  const log = SafetyLog.open(dir);
  const spy = failingDirectorySync();
  try { expect(log.appendLock({ account: "acct_1" }).outcome).not.toBe("applied"); }
  finally { spy.mockRestore(); }
});

test("H1/P24: an unlock whose folder could not be synced is not reported applied", () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-ledger-h1-"));
  dirs.push(dir);
  const log = SafetyLog.open(dir);
  const lock = log.appendLock({ account: "acct_1" });
  const spy = failingDirectorySync();
  try { expect(log.appendUnlock(lock.id, { account: "acct_1" }).outcome).not.toBe("applied"); }
  finally { spy.mockRestore(); }
});

