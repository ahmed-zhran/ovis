import { AccountRecordError, isDeviceSafetyRecord, parseSafetyRecord, verifySafetyRecord } from "../../shared/account-records.ts";
import type { DeviceStore } from "../devices.ts";
import type { RecordOutcome } from "./records.ts";
import type { SafetyLog } from "./safety-log.ts";

/** A hand-delivered lift is a hint to read, never authority to thaw. */
export async function handedLift(value: unknown, store: DeviceStore, log: SafetyLog): Promise<RecordOutcome> {
  try {
    const lift = parseSafetyRecord(value);
    if (!isDeviceSafetyRecord(lift) || lift.kind !== "lift") return { id: lift.id, outcome: "refused", code: "record_invalid" };
    if (lift.account !== store.account()) return { id: lift.id, outcome: "refused", code: "account_mismatch" };
    if (!await verifySafetyRecord(lift)) return { id: lift.id, outcome: "refused", code: "signature_invalid" };
    if (lift.account !== store.account()) return { id: lift.id, outcome: "refused", code: "account_mismatch" };
    if (log.receipt(lift.id)) return { id: lift.id, outcome: "unchanged" };
    const kept = log.wait({ record: lift, got: "handed" });
    return { id: lift.id, outcome: "refused", code: kept ? "read_pending" : "account_unavailable" };
  } catch (error) {
    if (error instanceof AccountRecordError) return { id: null, outcome: "refused", code: "record_invalid" };
    throw error;
  }
}
