/** Queue a confirmed clock repair on the live PC, and apply it before account startup can replay any store. */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { isIsoTime } from "../../shared/account-records.ts";
import { isJsonObject } from "../http.ts";
import { publishPrivateState, writePrivateState } from "../private-state.ts";
import { DeviceJournal, type JournalInput } from "./device-journal.ts";
import { checkRestampFile, readRestampJson, readRestampState, restampAddress, restampLinks, rewriteRestamp, type RestampAddress, type RestampFolders, type RestampLink, type RestampMove } from "./restamp-state.ts";

const FILE = "restamp.json";
const ROLLBACK = "restamp-rollback.json";
const DAY = 86_400_000;
type Plan = { readonly v: 1; readonly by: string; readonly at: string; readonly base: string; readonly mapping: readonly RestampMove[]; readonly links?: readonly RestampLink[] };
type TimedSlot = RestampAddress & { readonly value: string };
type Install = "plugin" | "desktop" | "other";
type Applied = { readonly problem?: string; readonly retry?: true };

const iso = (at: number) => new Date(at).toISOString();
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const event = (by: string, how: string, label = how): JournalInput =>
  ({ kind: "account", how, key: null, no: null, row: null, by, account: null, label });
const planIdOf = (plan: Plan) => createHash("sha256").update(JSON.stringify(plan)).digest("hex");

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

function readPlan(path: string): Plan {
  const value = readRestampJson(path);
  if (!isJsonObject(value) || Object.keys(value).some(key => !["v", "by", "at", "base", "mapping", "links"].includes(key)) ||
    value.v !== 1 || typeof value.by !== "string" || value.by.length === 0 ||
    !isIsoTime(value.at) || !isIsoTime(value.base) || !Array.isArray(value.mapping) || value.mapping.length === 0) {
    throw new Error("Invalid restamp.json shape");
  }
  const mapping = value.mapping.map((entry: unknown): RestampMove => {
    if (!isJsonObject(entry) || Object.keys(entry).length !== 5 || typeof entry.store !== "string" || typeof entry.ref !== "string" ||
      !(entry.field === "created_at" || entry.field === "confirmed_at" || entry.field === "removed_at" || entry.field === "at") ||
      !isIsoTime(entry.old) || !isIsoTime(entry.new) || entry.new >= entry.old) throw new Error("Invalid restamp.json mapping entry");
    return { store: entry.store, ref: entry.ref, field: entry.field, old: entry.old, new: entry.new };
  });
  let links: RestampLink[] | undefined;
  if (value.links !== undefined) {
    if (!Array.isArray(value.links)) throw new Error("Invalid restamp.json links");
    const seen = new Set<string>();
    links = value.links.map((link: unknown): RestampLink => {
      const id = /^[0-9a-f]{32}$/;
      if (!isJsonObject(link) || Object.keys(link).length !== 4 ||
        (link.store !== "account-removed.json" && link.store !== "sibling/account-removed.json") ||
        typeof link.ref !== "string" || typeof link.old !== "string" || typeof link.new !== "string" ||
        !id.test(link.old) || !id.test(link.new) || link.old === link.new) throw new Error("Invalid restamp.json link");
      const address = JSON.stringify([link.store, link.ref]);
      if (seen.has(address)) throw new Error("A restamp.json link is named twice");
      seen.add(address);
      return { store: link.store, ref: link.ref, old: link.old, new: link.new };
    });
  }
  return { v: 1, by: value.by, at: value.at, base: value.base, mapping, ...(links === undefined ? {} : { links }) };
}

function matchesPlan(plan: Plan, state: ReturnType<typeof readRestampState>): boolean {
  const at = Date.parse(plan.at);
  const base = Date.parse(plan.base);
  if (base < at || base > at + DAY) throw new Error("Invalid restamp.json base");
  const original = new Map(state.own);
  const seen = new Set<string>();
  let matches = true;
  let last: RestampMove | undefined;
  for (const entry of plan.mapping) {
    const address = restampAddress(entry);
    const slot = original.get(address);
    if (seen.has(address) || Date.parse(entry.new) <= base || (last &&
      (entry.old < last.old || (entry.old === last.old ? entry.new !== last.new : entry.new <= last.new)))) {
      throw new Error("Invalid restamp.json timestamp order");
    }
    last = entry;
    seen.add(address);
    if (slot && (slot.value === entry.old || slot.value === entry.new)) original.set(address, { ...slot, value: entry.old });
    else matches = false;
  }
  return matches && Bun.deepEquals(moves(original.values(), base), plan.mapping);
}

function pendingPlans(folders: RestampFolders) {
  const sibling = folders.sibling;
  const paired = sibling && resolve(sibling) !== resolve(folders.stateDir) && existsSync(sibling) &&
    (!existsSync(folders.stateDir) || realpathSync(sibling) !== realpathSync(folders.stateDir));
  const origins: RestampFolders[] = paired ? [folders, { stateDir: sibling, sibling: folders.stateDir }] : [folders];
  return origins.flatMap(origin => [FILE, ROLLBACK].flatMap(name => {
    const path = join(origin.stateDir, name);
    return lstatSync(path, { throwIfNoEntry: false }) ? [{ origin, path, rollback: name === ROLLBACK }] : [];
  }));
}

export function deferRestampTombstoneMerge(folders: RestampFolders): boolean {
  try { return [...readRestampState(folders).own.values()].some(({ value }) => Date.parse(value) > Date.now() + DAY); }
  catch { return true; } // A merge must not coalesce denials if the unmerged inputs cannot be checked.
}

export function applyRestamp(folders: RestampFolders, siblingEligible: () => boolean): Applied {
  try {
    const pending = pendingPlans(folders);
    if (!pending.length) return {};
    if (process.platform === "win32") return { problem: "A restamp plan is pending; Windows cannot apply it." };
    const entry = pending[0];
    if (!entry || pending.length !== 1) throw new Error("Multiple restamp plans are pending across the two folders");
    const plan = readPlan(entry.path);
    const state = readRestampState(entry.origin);
    const matches = matchesPlan(plan, state);
    const limit = Date.now() + DAY;
    const replacements = new Map(plan.mapping.map((entry) => [restampAddress(entry), Date.parse(entry.new)]));
    let reason = state.nonOwn > limit || plan.mapping.some(move => Date.parse(move.new) <= state.nonOwn) ? "A time from elsewhere changed" :
      !matches ? "An own timestamp changed" : entry.rollback ? "The restamp inputs changed" : null;
    const links = plan.links ?? [];
    if (reason === null) {
      try {
        if (!Bun.deepEquals(restampLinks(state, plan.mapping, links), links)) reason = "An Unrevoke reference changed";
      } catch (error) { reason = message(error); }
    }
    if (reason === null && [...state.own].some(([address, slot]) => (replacements.get(address) ?? Date.parse(slot.value)) > limit)) {
      return { problem: "This clock is still too far behind the restamp.json plan; correct the clock and restart Ovis." };
    }
    const rollback = reason !== null;
    const dir = entry.origin.stateDir;
    const archive = join(dir, rollback ? "restamp-refused.json" : "restamp-done.json");
    const rollbackMarker = join(dir, ROLLBACK);
    checkRestampFile(archive);
    if (rollback && !entry.rollback) checkRestampFile(rollbackMarker);
    const journal = DeviceJournal.open(dir);
    const journalRefusal = journal.restampRefusal(state.journals.get(dir));
    if (journalRefusal !== null) throw new Error(journalRefusal);
    const planId = planIdOf(plan);
    const entries = journal.entries();
    const asked = [...entries].reverse().find(audit => audit.how === "restamp asked");
    if (asked?.label !== `restamp asked ${planId}`) throw new Error("restamp.json does not match the approved plan in the device journal");
    const writes = rewriteRestamp(state, plan.mapping, links, rollback);
    // Check identity only after the complete preflight, but before touching either folder.
    if (!siblingEligible()) throw new Error("The other folder belongs to a different relay identity");
    // Publish the rollback decision before any rollback write. A crash cannot turn it back into an apply.
    if (rollback && !entry.rollback) publishPrivateState(entry.path, rollbackMarker);
    for (const { path, doc } of writes) writePrivateState(path, doc, undefined, true);
    const problem = reason === null ? undefined : `${reason} after restamp.json was queued; run ovis recover --restamp again.`;
    const how = rollback ? "restamp refused" : "restamp applied";
    if (!entries.some(audit => audit.seq > asked.seq && audit.how === how && audit.label.endsWith(planId))) {
      journal.appendRestamp(event(plan.by, how, `${problem ?? how} ${planId}`));
    }
    publishPrivateState(rollback ? rollbackMarker : entry.path, archive);
    return problem === undefined ? {} : { problem, retry: true };
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
      const journalRefusal = options.journal.restampRefusal(state.journals.get(options.stateDir));
      if (journalRefusal !== null) return { error: journalRefusal };
      if (pendingPlans(options).length !== 0) return { error: "A restamp is already pending; restart Ovis before queuing another." };
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
      const links = restampLinks(state, mapping);
      const plan: Plan = { v: 1, by: user, at, base: iso(base), mapping, ...(links.length ? { links } : {}) };
      if (confirm === undefined) {
        const token = randomBytes(16).toString("hex");
        preview = { token, plan };
        return { confirm: token, moves: mapping };
      }
      preview = undefined;
      if (JSON.stringify(plan) !== JSON.stringify(approved?.plan)) {
        return { error: "The restamp inputs changed; run ovis recover --restamp again." };
      }
      const path = join(options.stateDir, FILE);
      checkRestampFile(path);
      options.journal.appendRestamp(event(user, "restamp asked", `restamp asked ${planIdOf(plan)}`));
      writePrivateState(path, plan, undefined, true);
      return { queued: true, install: options.install };
    } catch (error) {
      return { error: `${message(error)}. This PC stays closed.` };
    }
  };
}
