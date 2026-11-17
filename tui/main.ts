/**
 * The terminal screen's entry: `ovis tui [--session NAME] | -h | -V`. It answers its arguments before it loads anything
 * heavy, works out the core to join and refuses to run inside a pane of that same core, then wires the real host
 * terminal, the clock and the loop together and turns how the loop ended into one line and an exit code. Every error it
 * prints carries a stable code. It starts no process: with no core listening it says so and ends.
 */

import { homedir } from "node:os";
import { version } from "../package.json";
import { insideOwnCore, parseArgs, stateFolder, targetEnv, USAGE } from "./start.ts";

/** The exit codes: 0 detached, 1 the screen could not run (a code says why), 2 a wrong call, 70 a crash. */
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_CRASH = 70;

const say = (code: string, text: string) => process.stderr.write(`ovis tui: ${code}: ${text}\n`);

const args = parseArgs(process.argv.slice(2));
if (args.kind === "help") {
  process.stdout.write(`${USAGE}\n\nThe herdr-core screen. --session NAME joins that hc session (else HC_SESSION, else default).\nThe detach key of herdr leaves it; the agents keep running in herdr-core.\n`);
  process.exit(EXIT_OK);
}
if (args.kind === "version") {
  process.stdout.write(`${version}\n`);
  process.exit(EXIT_OK);
}
if (args.kind === "bad") {
  say("usage", `${args.message}\n${USAGE}`);
  process.exit(EXIT_USAGE);
}

const env = process.env;
const { coreSocket } = await import("../server/herdr-core/core-socket.ts");
const { sameSocket } = await import("../server/herdr/test-session.ts");
const target = coreSocket({ env: targetEnv(env, args.session) });
if (insideOwnCore(env, target.path, coreSocket({ env }).path, sameSocket)) {
  say("inside_own_core", `this runs inside a pane of herdr-core session ${target.session}; open the screen from a terminal outside it, or join another session with --session NAME`);
  process.exit(EXIT_FAILED);
}

const { herdrConfigPath, readHerdrConfig } = await import("../server/herdr-sidebar.ts");
const { createUnixHost } = await import("./host/unix.ts");
const { startLoop } = await import("./loop.ts");
const { crashRecord, recordCrash } = await import("./crash.ts");

const readKeys = (): unknown => {
  const config = readHerdrConfig(herdrConfigPath(env));
  return config !== null && typeof config === "object" ? (config as Record<string, unknown>)["keys"] : undefined;
};

const host = createUnixHost();
const loop = startLoop({
  host,
  clock: { now: () => performance.now(), arm: (at, fire) => { const timer = setTimeout(fire, Math.max(0, at - performance.now())); return () => clearTimeout(timer); } },
  socket: target.path,
  keys: readKeys(),
  readKeys,
});

/** An error nothing expected: the terminal back first, then the record, its path, and the crash's exit code. */
const crash = (error: unknown): never => {
  let where = "";
  try {
    where = recordCrash(() => host.leave(), stateFolder(env, homedir()), crashRecord(version, loop.report(), error, new Date()), process.pid);
  } catch {
    // the folder cannot be written: the line below says so
  }
  say("crashed", where ? `the screen stopped on an unexpected error; a record is in ${where}` : "the screen stopped on an unexpected error; no record could be written");
  process.exit(EXIT_CRASH);
};
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);

const end = await loop.done;
switch (end.kind) {
  case "quit":
    process.stdout.write(`ovis tui: detached from herdr-core session ${target.session}; its terminals and agents keep running.\n`);
    process.exit(EXIT_OK);
    break;
  case "crashed":
    crash(end.error);
    break;
  case "no_core":
    say(end.code, `no herdr-core answers at ${target.path} (session ${target.session}); start one with \`hc server start\`, or run \`ovis\` to be asked`);
    process.exit(EXIT_FAILED);
    break;
  case "incompatible":
    say(end.code, end.reason);
    process.exit(EXIT_FAILED);
    break;
  case "not_a_terminal":
    say("not_a_terminal", "stdin and stdout must both be a terminal");
    process.exit(EXIT_FAILED);
    break;
  case "gone":
    // a hang-up is a signal: the host ends the process with 129 itself once the channels are closed
    if (end.why === "hangup") break;
    host.leave();
    say("terminal_gone", "the terminal refused a write; the agents keep running in herdr-core");
    process.exit(EXIT_FAILED);
    break;
  case "signal":
    // the host gave the terminal back and ends the process with 128 + the signal's number
    break;
}
