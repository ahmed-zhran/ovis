/** Read the restamp inputs without opening stores or running their repair and merge paths. */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { isIsoTime } from "../../shared/account-records.ts";
import { parseAccountDevicesFile } from "../../shared/account-snapshot.ts";
import { parseTombstones, readDeviceRegistry } from "../devices.ts";
import { isJsonObject } from "../http.ts";
import { privateStateRefusal } from "../private-state.ts";
import { ACCOUNT_DEVICES_FILE } from "./account-devices.ts";
import { ADMISSION_FILE } from "./admission-order.ts";
import { parsePcAccount } from "./pc-binding.ts";
import { localRevokeId, parseEvidence, REMOVAL_FILE } from "./removal-evidence.ts";
import { DEVICE_JOURNAL_FILE, parseLog, SAFETY_LOG_FILE } from "./safety-log.ts";

export type RestampField = "created_at" | "confirmed_at" | "removed_at" | "at";
export type RestampAddress = { readonly store: string; readonly ref: string; readonly field: RestampField };
export type RestampMove = RestampAddress & { readonly old: string; readonly new: string };
export type RestampFolders = { readonly stateDir: string; readonly sibling?: string | null | undefined };
type Doc = Record<string, unknown>;
type Slot = RestampAddress & { readonly value: string; readonly row: Doc };

export function readRestampJson(path: string): unknown {
  const refused = privateStateRefusal(path);
  if (refused !== null) throw new Error(refused);
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error(`Cannot read ${path}`, { cause: error });
  }
}

export function restampAddress({ store, ref, field }: RestampAddress): string {
  return JSON.stringify([store, ref, field]);
}

export function readRestampState(folders: RestampFolders) {
  const own = new Map<string, Slot>();
  const docs = new Map<string, { path: string; doc: Doc }>();
  const revokes = new Set<Slot>();
  const localTombstones = new Set<Slot>();
  let nonOwn = -Infinity;
  const floor = (value: string) => {
    if (!isIsoTime(value)) throw new Error(`A timestamp from elsewhere is not ISO: ${value}`);
    nonOwn = Math.max(nonOwn, Date.parse(value));
  };
  const sibling = folders.sibling;
  const real = (dir: string) => realpathSync(dir, { encoding: "utf8" });
  const read = (dir: string, store: string, file: string) => {
    const path = join(dir, file);
    const doc = readRestampJson(path);
    if (doc === undefined) return undefined;
    if (!isJsonObject(doc)) throw new Error(`Cannot read ${path}`);
    docs.set(store, { path, doc });
    return doc;
  };
  const slot = (store: string, ref: string, field: RestampField, row: Doc) => {
    const value = row[field];
    if (!isIsoTime(value)) throw new Error(`Malformed own timestamp in ${store} (${ref}, ${field}): not ISO`);
    const address = restampAddress({ store, ref, field });
    if (own.has(address)) throw new Error(`Duplicate timestamp reference in ${store}: ${ref}`);
    const entry = { store, ref, field, value, row };
    own.set(address, entry);
    return entry;
  };
  const rows = (list: unknown, each: (row: Doc, index: number) => void) => {
    if (!Array.isArray(list)) throw new Error("A timestamp store has no row list");
    for (const [index, row] of list.entries()) {
      if (!isJsonObject(row)) throw new Error("A timestamp row is not an object");
      each(row, index);
    }
  };

  const main = folders.stateDir;
  const dirs = [{ dir: main, prefix: "" }];
  if (sibling && resolve(main) !== resolve(sibling) && existsSync(sibling) && real(main) !== real(sibling)) dirs.push({ dir: sibling, prefix: "sibling/" });
  for (const { dir, prefix } of dirs) {
    // Sibling merges share the ordinary registry and evidence; their old copies must not be imported again.
    const store = prefix + "devices.json";
    const devices = read(dir, store, "devices.json");
    const hasJournal = existsSync(join(dir, DEVICE_JOURNAL_FILE));
    const binding = readRestampJson(join(dir, ADMISSION_FILE));
    const pc = binding === undefined ? null : parsePcAccount(binding);
    if (typeof pc === "string" || (pc === null && hasJournal)) throw new Error(`Cannot read ${prefix}${ADMISSION_FILE}`);
    if (devices !== undefined) {
      const registry = readDeviceRegistry(join(dir, "devices.json"), true);
      if (registry.kind !== "ok") throw new Error(`Cannot read ${store}`);
      if (registry.devices.some(row => row.origin && row.origin.from !== "legacy" && (!pc || row.origin.admit_no >= pc.next_admit))) {
        throw new Error(`${prefix}${ADMISSION_FILE} does not account for its numbered rows`);
      }
      rows(devices.devices, (row) => slot(store, String(row.id), "created_at", row));
    }
    if (prefix === "") {
      const listed = read(dir, ACCOUNT_DEVICES_FILE, ACCOUNT_DEVICES_FILE);
      if (listed !== undefined) {
        rows(listed.devices, (row) => slot(ACCOUNT_DEVICES_FILE, String(row.id), "confirmed_at", row));
        parseAccountDevicesFile(listed);
      }
    }
    for (const file of ["account-tombstones.json", "account-tombstones.pending.json"]) {
      const store = prefix + file;
      const doc = read(dir, store, file);
      if (doc === undefined) continue;
      if (parseTombstones(doc) === null) throw new Error(`Cannot read ${store}`);
      rows(doc.tombstones, (row, index) => {
        if (row.record_id === "local") localTombstones.add(slot(store, JSON.stringify([row.key, row.account, index]), "removed_at", row));
        else if (typeof row.removed_at === "string") floor(row.removed_at);
      });
    }
    const removalStore = prefix + REMOVAL_FILE;
    const evidence = read(dir, removalStore, REMOVAL_FILE);
    if (evidence === undefined && (hasJournal || pc?.evidence_written)) throw new Error(`${removalStore} is missing`);
    if (evidence !== undefined) {
      const parsed = parseEvidence(evidence);
      if (parsed === null) throw new Error(`Cannot read ${removalStore}`);
      // paired_over holds IDs of these marker removals, never independent timestamps.
      for (const marker of parsed.markers) for (const removal of marker.removals) floor(removal.at);
      // The Revoke ID changes with its at; key, account and file position do not.
      rows(evidence.revokes, (row, index) => { revokes.add(slot(removalStore, JSON.stringify([row.key, row.account, index]), "at", row)); });
      rows(evidence.unrevokes, (row) => slot(removalStore, String(row.id), "at", row));
    }
    const log = read(dir, prefix + SAFETY_LOG_FILE, SAFETY_LOG_FILE);
    if (log === undefined && hasJournal) throw new Error(`${prefix}${SAFETY_LOG_FILE} is missing`);
    if (log !== undefined) {
      const parsed = parseLog(log);
      if (typeof parsed === "string" || parsed.overflowed) throw new Error(`Cannot read ${prefix}${SAFETY_LOG_FILE}`);
      for (const entry of parsed.entries) {
        const cutoff = entry.asof?.legacy_created_at;
        if (cutoff !== undefined) nonOwn = Math.max(nonOwn, cutoff);
        // Startup replays standing signed Blocks into removal markers if their marker did not reach disk.
        if (entry.record.kind === "block") floor(entry.record.signed_at);
      }
    }
  }
  return { own, nonOwn, docs, revokes, localTombstones };
}

/** Build replacements in memory so a collision or an invalid derived ID cannot leave partial writes. */
export function rewriteRestamp(state: ReturnType<typeof readRestampState>, mapping: readonly RestampMove[]) {
  const changed = new Set<string>();
  const moveBySlot = new Map(mapping.map((move) => [restampAddress(move), move]));
  const ids = new Map<string, { old: string; next: string }>();
  const oldByNew = new Map<string, string>();
  const occupied = new Map<unknown, Slot[]>();
  for (const slot of [...state.revokes, ...state.localTombstones]) {
    const { key, account } = slot.row;
    if (typeof key !== "string" || !(account === null || typeof account === "string")) throw new Error("Invalid Revoke or local tombstone");
    const id = slot.field === "removed_at" ? localRevokeId(key, account ?? "", slot.value) : slot.row.id;
    const copies = occupied.get(id);
    if (copies) copies.push(slot);
    else occupied.set(id, [slot]);
    const move = moveBySlot.get(restampAddress(slot));
    if (!move) continue;
    const old = localRevokeId(key, account ?? "", move.old);
    const next = localRevokeId(key, account ?? "", move.new);
    if (id !== (slot.value === move.old ? old : next)) throw new Error("A Revoke does not have its derived ID");
    if (old === next || (oldByNew.has(next) && oldByNew.get(next) !== old)) throw new Error("A restamped Revoke ID would collide");
    oldByNew.set(next, old);
    ids.set(restampAddress(slot), { old, next });
  }
  for (const { old, next } of ids.values()) {
    if (occupied.get(next)?.some((slot) => ids.get(restampAddress(slot))?.old !== old) ||
      occupied.get(old)?.some((slot) => ids.get(restampAddress(slot))?.next !== next)) throw new Error("A restamped Revoke ID would collide");
  }
  const nextByOld = new Map([...oldByNew].map(([next, old]) => [old, next]));
  for (const move of mapping) {
    const address = restampAddress(move);
    const slot = state.own.get(address);
    if (!slot) throw new Error("A restamp timestamp does not name an own time");
    if (slot.value === move.old) {
      const id = ids.get(address);
      if (id && state.revokes.has(slot)) slot.row.id = id.next;
      slot.row[slot.field] = move.new;
      changed.add(slot.store);
    }
  }
  for (const [store, { doc }] of state.docs) {
    if (!store.endsWith(REMOVAL_FILE) || !Array.isArray(doc.unrevokes)) continue;
    for (const row of doc.unrevokes) {
      if (!isJsonObject(row) || typeof row.revoke !== "string") continue;
      const next = nextByOld.get(row.revoke);
      if (next !== undefined) {
        row.revoke = next;
        changed.add(store);
      }
    }
  }
  return [...state.docs].filter(([store]) => changed.has(store)).map(([, doc]) => doc);
}
