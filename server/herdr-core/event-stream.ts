/**
 * hc's event stream, read line by line: each event, and one signal for every reason what was read
 * can no longer be trusted. Its reader decides what a resync means (the adapter ends herdr's
 * subscription; the terminal screen reads the core afresh).
 */

import { makeLineReader } from "../herdr/line-reader.ts";
import type { HcConnection } from "./connection.ts";
import type { HcEvent } from "./core-model.ts";
import { isRecord } from "./snapshot.ts";

/** A status or layout notification must fit in 4 MiB, even across hc frames. */
export const EVENT_LINE_BYTES = 4 * 1024 * 1024;

/** What an hc event stream tells its reader. */
interface EventStreamHandlers {
  /** an event, this core's own or another machine's */
  event: (event: HcEvent) => void;
  /** what was read can no longer be trusted (hc says events were `missed`, a line is not JSON, or the stream closed): read the state afresh */
  resync: () => void;
  /** a line passed EVENT_LINE_BYTES: the stream reads nothing more */
  tooLong: () => void;
}

/** Opens hc's event stream: its answer carries hc's snapshot (`result.terminals`) and the stream's channel. */
export function openEventStream(hc: Pick<HcConnection, "open">, on: EventStreamHandlers) {
  const read = makeLineReader(EVENT_LINE_BYTES, (line) => {
    let message: unknown;
    try { message = JSON.parse(line); } catch { on.resync(); return; }
    if (!isRecord(message)) return;
    if (message["method"] === "missed") { on.resync(); return; }
    const params = message["params"];
    if (message["method"] !== "event" || !isRecord(params) || typeof params["type"] !== "string") return;
    on.event({ type: params["type"], ...(typeof params["terminal"] === "string" ? { terminal: params["terminal"] } : {}), ...(typeof params["machine"] === "string" ? { machine: params["machine"] } : {}), ...(isRecord(params["data"]) ? { data: params["data"] } : {}) });
  }, () => on.tooLong());
  return hc.open("events.subscribe", {}, { onData: read, onClose: () => on.resync() });
}
