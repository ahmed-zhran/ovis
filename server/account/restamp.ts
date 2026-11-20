/** Queue a confirmed clock repair on the live PC, and apply it before account startup can replay any store. */
import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { isIsoTime } from "../../shared/account-records.ts";
import { isJsonObject } from "../http.ts";
import { publishPrivateState, writePrivateState } from "../private-state.ts";
import type { DeviceJournal, JournalInput } from "./device-journal.ts";
import { readRestampJson, readRestampState, restampAddress, rewriteRestamp, type RestampAddress, type RestampFolders, type RestampMove } from "./restamp-state.ts";

const FILE = "restamp.json";
const DAY = 86_400_000;
type Plan = { readonly v: 1; readonly by: string; readonly at: string; readonly base: string; readonly mapping: readonly RestampMove[] };
type TimedSlot = RestampAddress & { readonly value: string };
type Install = "plugin" | "desktop" | "other";
type Applied = { readonly audit?: JournalInput; readonly problem?: string; readonly retry?: true };

const iso = (at: number) => new Date(at).toISOString();
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const event = (by: string, how: string, label = how): JournalInput =>
  ({ kind: "account", how, key: null, no: null, row: null, by, account: null, label });

function moves(slots: Iterable<TimedSlot>, base: number): RestampMove[] {
  const future = [...slots].filter(({ value }) => Date.parse(value) > base).sort((a, b) => Date.parse(a.value) - Date.parse(b.value));
  const mapping: RestampMove[] = [];
  let count = 0;
  let last: string | undefined;
  for (const { store, ref, field, value } of future) {
    if (value !== last) { last = value; count++; }
    const next = iso(base + count);
    if (next !== value) mapping.push({ store, ref, field, old: value, new: next });
  }
  return mapping;
}

function readPlan(folders: RestampFolders): Plan | undefined {
  const path = join(folders.stateDir, FILE);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o022) !== 0)) throw new Error("restamp.json is not a private regular file");
  const value = readRestampJson(path);
  if (!isJsonObject(value) || Object.keys(value).length !== 5 || value.v !== 1 || typeof value.by !== "string" || value.by.length === 0 ||
    !isIsoTime(value.at) || !isIsoTime(value.base) || !Array.isArray(value.mapping) || value.mapping.length === 0) {
    throw new Error("Invalid restamp.json shape");
  }
  const mapping = value.mapping.map((entry: unknown): RestampMove => {
    if (!isJsonObject(entry) || Object.keys(entry).length !== 5 || typeof entry.store !== "string" || typeof entry.ref !== "string" ||
      !(entry.field === "created_at" || entry.field === "confirmed_at" || entry.field === "removed_at" || entry.field === "at") ||
      !isIsoTime(entry.old) || !isIsoTime(entry.new) || entry.new >= entry.old) throw new Error("Invalid restamp.json mapping entry");
    return { store: entry.store, ref: entry.ref, field: entry.field, old: entry.old, new: entry.new };
  });
  return { v: 1, by: value.by, at: value.at, base: value.base, mapping };
}

function checkPlan(plan: Plan, state: ReturnType<typeof readRestampState>): void {
  const at = Date.parse(plan.at);
  const base = Date.parse(plan.base);
  if (base < at || base > at + DAY) throw new Error("Invalid restamp.json base");
  const original = new Map(state.own);
  const seen = new Set<string>();
  for (const entry of plan.mapping) {
    const address = restampAddress(entry);
    const slot = original.get(address);
    if (!slot || seen.has(address) || (slot.value !== entry.old && slot.value !== entry.new)) {
      throw new Error("A restamp.json entry is not a matching own time");
    }
    seen.add(address);
    original.set(address, { ...slot, value: entry.old });
  }
  if (JSON.stringify(moves(original.values(), base)) !== JSON.stringify(plan.mapping)) {
    throw new Error("The restamp.json mapping does not match the original times, base and order");
  }
}

export function applyRestamp(folders: RestampFolders): Applied {
  try {
    const plan = readPlan(folders);
    if (!plan) return {};
    const state = readRestampState(folders);
    checkPlan(plan, state);
    // The approved wall-clock base stays fixed across restarts. Only new comparison evidence can invalidate it.
    const limit = Date.now() + DAY;
    const replacements = new Map(plan.mapping.map((entry) => [restampAddress(entry), Date.parse(entry.new)]));
    if (state.nonOwn > limit || plan.mapping.some((entry) => Date.parse(entry.new) <= state.nonOwn)) {
      const problem = "A time from elsewhere changed after restamp.json was queued; run ovis recover --restamp again.";
      return { problem, retry: true, audit: event(plan.by, "restamp refused", problem) };
    }
    if ([...state.own].some(([address, slot]) => (replacements.get(address) ?? Date.parse(slot.value)) > limit)) {
      return { problem: "This clock is still too far behind the restamp.json plan; correct the clock and restart Ovis." };
    }
    for (const { path, doc } of rewriteRestamp(state, plan.mapping)) writePrivateState(path, doc);
    publishPrivateState(join(folders.stateDir, FILE), join(folders.stateDir, "restamp-done.json"));
    return { audit: event(plan.by, "restamp applied") };
  } catch (error) {
    return { problem: `Cannot apply restamp.json: ${message(error)}. Only this PC itself gets in.` };
  }
}

export function restampAct(options: RestampFolders & {
  readonly problem: () => string | null;
  readonly journal: DeviceJournal;
  readonly install: Install;
}) {
  let preview: { token: string; plan: Plan } | undefined;
  return (confirm: string | undefined, user: string) => {
    try {
      // One synchronous turn covers the readability check, plan recheck, journal and private replacement.
      const refused = options.problem();
      if (refused !== null) return { error: refused };
      const state = readRestampState(options);
      const pending = readPlan(options);
      if (pending?.mapping.some(entry => state.own.get(restampAddress(entry))?.value === entry.new)) {
        return { error: "The pending restamp was partly applied. Its plan must be replayed, not replaced." };
      }
      const approved = preview;
      if (confirm !== undefined && (approved === undefined || confirm !== approved.token)) {
        return { error: "The restamp preview no longer matches; run ovis recover --restamp again." };
      }
      const now = Date.now();
      const at = approved && confirm !== undefined ? approved.plan.at : iso(now);
      const base = Math.max(Date.parse(at), state.nonOwn);
      if (base > now + DAY) return { error: "A time from elsewhere is more than a day ahead; this PC stays closed." };
      if (![...state.own.values()].some(({ value }) => Date.parse(value) > now + DAY)) {
        return { error: "No own timestamp is more than a day ahead now; check the clock and restart Ovis." };
      }
      const mapping = moves(state.own.values(), base);
      const replacements = new Map(mapping.map(entry => [restampAddress(entry), Date.parse(entry.new)]));
      if (mapping.length === 0 || [...state.own].some(([address, slot]) => (replacements.get(address) ?? Date.parse(slot.value)) > now + DAY)) {
        return { error: "The restamp would leave a time more than a day ahead; this PC stays closed." };
      }
      const plan: Plan = { v: 1, by: user, at, base: iso(base), mapping };
      if (confirm === undefined) {
        rewriteRestamp(state, mapping);
        const token = randomBytes(16).toString("hex");
        preview = { token, plan };
        return { confirm: token, moves: mapping };
      }
      preview = undefined;
      if (JSON.stringify(plan) !== JSON.stringify(approved?.plan)) {
        return { error: "The restamp inputs changed; run ovis recover --restamp again." };
      }
      rewriteRestamp(state, mapping);
      options.journal.append(event(user, "restamp asked"));
      writePrivateState(join(options.stateDir, FILE), plan);
      return { queued: true, install: options.install };
    } catch (error) {
      return { error: `${message(error)}. This PC stays closed.` };
    }
  };
}
