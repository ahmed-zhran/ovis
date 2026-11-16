/**
 * The real host (tui/host/unix.ts) in a small entry, for tui/host/restore.contract.test.ts:
 *
 *   bun tui/testing/host-fixture.ts exit|linger|process-exit|throw|wait
 *
 * It enters, listens, runs the probe and reports on the terminal it holds: `PROBE <ms> <json>`, `DEPTH`,
 * `RESIZE <cols>x<rows>`, `INPUT <length> <hex of the first 32 bytes>`, then `READY`. A `q` ends it the
 * way its argument names: `exit` leaves and lets the loop run dry, `linger` leaves and stays until a
 * signal (so the termios can be read after leave while it still runs), `process-exit` calls
 * process.exit(0) without leaving, `throw` throws from the input listener; `wait` ends only by a
 * signal. Not a terminal: one line on stderr, exit 3.
 */
import { createUnixHost } from "../host/unix.ts";

const mode = process.argv[2] ?? "wait";
const host = createUnixHost();
const say = (line: string) => host.write(`${line}\r\n`);

if (!host.enter()) {
  process.stderr.write("host-fixture: not a terminal\n");
  process.exit(3);
}
// listening before the probe, so that anything the probe let through would show
host.onInput((bytes) => {
  say(`INPUT ${bytes.length} ${Buffer.from(bytes.subarray(0, 32)).toString("hex")}`);
  if (!bytes.includes(0x71)) return;
  if (mode === "exit") host.leave();
  else if (mode === "linger") { host.leave(); setInterval(() => {}, 1000); }
  else if (mode === "process-exit") process.exit(0);
  else if (mode === "throw") throw new Error("fixture: thrown on purpose");
});
host.onResize(({ cols, rows }) => say(`RESIZE ${cols}x${rows}`));
const asked = performance.now();
const result = await host.probe();
say(`PROBE ${Math.round(performance.now() - asked)} ${JSON.stringify(result)}`);
say(`DEPTH ${host.colorDepth}`);
say("READY");
