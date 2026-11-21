import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenOwner } from "./browserBroker.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const token = (fill: string) => fill.repeat(43);

it("answers a token with the pane beside it, a moved pane's new id, or the name of a token from before keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-broker-owner-"));
  dirs.push(dir);
  writeFileSync(join(dir, "k1.token"), token("a"));
  writeFileSync(join(dir, "k1.pane"), "w1-p1");
  writeFileSync(join(dir, "old.token"), token("b"));
  expect(tokenOwner(dir, token("a"))).toBe("w1-p1");
  writeFileSync(join(dir, "k1.pane"), "w2-p1");
  expect(tokenOwner(dir, token("a"))).toBe("w2-p1");
  expect(tokenOwner(dir, token("b"))).toBe("old");
  expect(tokenOwner(dir, token("c"))).toBeNull();
  writeFileSync(join(dir, "k1.pane"), "../x");
  expect(tokenOwner(dir, token("a"))).toBeNull();
});
