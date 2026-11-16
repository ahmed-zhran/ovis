import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket, UnixSocketListener } from "bun";
import { HcError, type HcTransport } from "./connection.ts";
import { coreSocket } from "./core-socket.ts";
import { connectCoreSocket } from "./socket-transport.ts";

const WAIT_MS = 5000;

// a unix socket and a shell stand-in for hc: the Windows pipe is reached by the same Bun.connect
describe.skipIf(process.platform === "win32")("the socket transport", () => {
  /** short: a unix socket path must stay within the OS's 107 bytes */
  const dir = mkdtempSync(join(tmpdir(), "r9-"));
  /** the stand-ins' log: one line per run of `hc` or `herdr-core` by name, with its arguments */
  const hcLog = join(dir, "hc.log");
  /** connects to each path (`no-core <path>…`, printing each error's kind), or starts hc by name both ways (`control`) */
  const childScript = join(dir, "child.ts");
  const NAMES = ["HOME", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "HC_SOCKET", "HC_SESSION", "HERDR_TEST_SESSION", "HERDR_TEST_LIVE", "OVIS_ALLOW_LIVE_HERDR"] as const;
  const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
  const listeners: UnixSocketListener<undefined>[] = [];
  const transports: HcTransport[] = [];

  const waiters = new Set<{ check: () => boolean; resolve: () => void }>();
  const wake = () => { for (const waiter of [...waiters]) if (waiter.check()) { waiters.delete(waiter); waiter.resolve(); } };
  const until = (label: string, check: () => boolean): Promise<void> => {
    if (check()) return Promise.resolve();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const waiter = { check, resolve: () => { clearTimeout(timer); resolve(); } };
    const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`no ${label} within ${WAIT_MS}ms`)); }, WAIT_MS);
    waiters.add(waiter);
    return promise;
  };

  /** a core stand-in: what it was sent, and its open connections */
  const listen = (path: string) => {
    const got: Uint8Array[] = [];
    const peers: Socket<undefined>[] = [];
    let closed = 0;
    const listener = Bun.listen({
      unix: path,
      socket: {
        open: (socket) => { peers.push(socket); wake(); },
        data: (_socket, chunk) => { got.push(new Uint8Array(chunk)); wake(); },
        close: () => { closed++; wake(); },
      },
    });
    listeners.push(listener);
    return { listener, got, peers, closed: () => closed, bytes: () => Buffer.concat(got) };
  };
  const connect = async (path: string) => {
    const transport = await connectCoreSocket(path);
    transports.push(transport);
    return transport;
  };
  const failureOf = (path?: string) => connectCoreSocket(path).then(
    (transport) => { transports.push(transport); return null; },
    (error: unknown) => (error instanceof HcError ? error.kind : String(error)),
  );
  const hcRuns = () => (existsSync(hcLog) ? readFileSync(hcLog, "utf8") : "");
  /** processes still running from a child run: each inherits its OVIS_STANDIN_RUN, whichever way it was spawned */
  const fromChildRun = () => readdirSync("/proc").filter((pid) => /^\d+$/.test(pid)).filter((pid) => {
    try { return readFileSync(`/proc/${pid}/environ`, "latin1").includes(`OVIS_STANDIN_RUN=${dir}\0`); } catch { return false; }
  });

  /**
   * Runs the child script in a `bun` whose startup environment, built here, has the stand-ins first on
   * PATH: a spawn of `hc` or `herdr-core` by name finds them whether or not it passes `env`, and leaves
   * a line in the log. A spawn by absolute path is not seen here; server/conventions.test.ts finds
   * any process start in the transport's imports. Returns the child's lines once every process of the
   * run has ended, so a spawn nobody awaited has written its line. `extra` adds to that environment.
   */
  const runChild = async (extra: Record<string, string>, ...args: string[]): Promise<string[]> => {
    const child = Bun.spawn([process.execPath, childScript, ...args], {
      env: { PATH: `${join(dir, "bin")}:${process.env["PATH"] ?? "/usr/bin:/bin"}`, HOME: join(dir, "home"), TMPDIR: dir, OVIS_STANDIN_RUN: dir, ...extra },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    const deadline = Date.now() + WAIT_MS;
    while (fromChildRun().length > 0) {
      if (Date.now() > deadline) throw new Error(`processes of the child run still running after ${WAIT_MS}ms: ${fromChildRun().join(", ")}`);
      await Bun.sleep(25);
    }
    return out.trim().split("\n");
  };

  beforeAll(() => {
    mkdirSync(join(dir, "bin"));
    for (const name of ["hc", "herdr-core"]) {
      writeFileSync(join(dir, "bin", name), `#!/bin/sh\necho "${name} $*" >> '${hcLog}'\n`);
      chmodSync(join(dir, "bin", name), 0o755);
    }
    writeFileSync(childScript, [
      `import { connectCoreSocket } from ${JSON.stringify(join(import.meta.dir, "socket-transport.ts"))};`,
      "const [mode, ...paths] = process.argv.slice(2);",
      "if (mode === \"control\") {",
      "  Bun.spawn([\"hc\", \"with-env\"], { env: process.env, stdout: \"ignore\", stderr: \"ignore\" });",
      "  Bun.spawn([\"hc\", \"without-env\"], { stdout: \"ignore\", stderr: \"ignore\" });",
      "} else {",
      "  for (const path of paths) console.log(await connectCoreSocket(path).then((line) => { line.kill(); return \"connected\"; }, (error) => error?.kind ?? String(error)));",
      "}",
    ].join("\n"));
  });

  afterEach(() => {
    for (const transport of transports.splice(0)) transport.kill();
    for (const listener of listeners.splice(0)) listener.stop(true);
    for (const name of NAMES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("carries frames to the socket byte for byte and in order, and the socket's bytes to readable", async () => {
    const path = join(dir, "rt.sock");
    const core = listen(path);
    const transport = await connect(path);
    // more than a socket buffer takes at once, so some writes wait for the socket to drain
    const frames = Array.from({ length: 64 }, (_, at) => new Uint8Array(at === 32 ? 4 * 1024 * 1024 : 1 + at * 97).fill(at));
    for (const frame of frames) transport.write(frame);
    const sent = Buffer.concat(frames);
    await until(`${sent.length} bytes at the socket`, () => core.bytes().length >= sent.length);
    expect(core.bytes().equals(sent)).toBe(true);

    const reader = transport.readable.getReader();
    const answer = new TextEncoder().encode("hello back\n");
    await until("the transport's connection", () => core.peers.length === 1);
    core.peers[0]!.write(answer);
    const read: Uint8Array[] = [];
    while (Buffer.concat(read).length < answer.length) {
      const { done, value } = await reader.read();
      if (done) break;
      read.push(value);
    }
    expect(Buffer.concat(read).equals(Buffer.from(answer))).toBe(true);
    reader.releaseLock();
  });

  // the child runs need /proc to tell when every process of a run has ended
  it.skipIf(process.platform !== "linux")("the stand-in sees a spawn of hc by name, with env and without", async () => {
    expect(await runChild({}, "control")).toEqual([""]);
    expect(hcRuns().split("\n").filter(Boolean).sort()).toEqual(["hc with-env", "hc without-env"]);
    rmSync(hcLog);
  });

  it.skipIf(process.platform !== "linux")("missing socket file gives no_core", async () => {
    expect(await runChild({}, "no-core", join(dir, "absent.sock"))).toEqual(["no_core"]);
    expect(hcRuns()).toBe("");
  });

  it.skipIf(process.platform !== "linux")("stale socket file refuses", async () => {
    const live = join(dir, "live.sock");
    const stale = join(dir, "stale.sock");
    const core = listen(live);
    // a stopped listener removes its file; a second name keeps it, as a core that was killed leaves its socket
    linkSync(live, stale);
    core.listener.stop(true);
    expect(existsSync(stale)).toBe(true);
    expect(await runChild({}, "no-core", stale)).toEqual(["no_core"]);
    expect(hcRuns()).toBe("");
  });

  it("kill closes the socket and settles exited", async () => {
    const path = join(dir, "kill.sock");
    const core = listen(path);
    const transport = await connect(path);
    await until("the transport's connection", () => core.peers.length === 1);
    let settled = false;
    void transport.exited.then(() => { settled = true; wake(); });
    transport.kill();
    await until("exited", () => settled);
    await until("the socket's close at the core", () => core.closed() === 1);
    expect((await transport.readable.getReader().read()).done).toBe(true);
  });

  it("settles exited on kill after the reader was cancelled", async () => {
    const path = join(dir, "cancel.sock");
    const core = listen(path);
    const transport = await connect(path);
    await until("the transport's connection", () => core.peers.length === 1);
    let settled = false;
    void transport.exited.then(() => { settled = true; wake(); });
    await transport.readable.getReader().cancel();
    transport.kill();
    await until("exited", () => settled);
  });

  it("settles exited and ends readable when the core closes the socket", async () => {
    const path = join(dir, "end.sock");
    const core = listen(path);
    const transport = await connect(path);
    await until("the transport's connection", () => core.peers.length === 1);
    let settled = false;
    void transport.exited.then(() => { settled = true; wake(); });
    core.peers[0]!.end();
    await until("exited", () => settled);
    expect((await transport.readable.getReader().read()).done).toBe(true);
  });

  it.skipIf(process.platform !== "linux")("the test-session guard refuses the user's default socket", async () => {
    // the user's default socket is under this test's own folders: a guard that let it through finds no core there
    const guarded = { HOME: join(dir, "home"), XDG_RUNTIME_DIR: join(dir, "run"), XDG_CONFIG_HOME: join(dir, "config"), HERDR_TEST_SESSION: "ovis-test-guard" };
    Object.assign(process.env, guarded);
    for (const name of ["HC_SOCKET", "HC_SESSION", "HERDR_TEST_LIVE", "OVIS_ALLOW_LIVE_HERDR"]) delete process.env[name];
    const userDefault = coreSocket().path;
    expect(userDefault.startsWith(dir)).toBe(true);
    // refused before any connect, so these may run here
    expect(await failureOf()).toBe("live_core_refused");
    // another spelling of the same socket
    expect(await failureOf(join(dir, "run", "herdr-core", "..", "herdr-core", "default.sock"))).toBe("live_core_refused");
    // a connect that reaches no core runs in the child, as every other one does: a core of the test's own is
    // not the user's while the guard holds there (the user's socket still is), and said out loud the user's may be reached
    expect(await runChild(guarded, "no-core", join(dir, "own.sock"), userDefault)).toEqual(["no_core", "live_core_refused"]);
    expect(await runChild({ ...guarded, OVIS_ALLOW_LIVE_HERDR: "1" }, "no-core", userDefault)).toEqual(["no_core"]);
    expect(hcRuns()).toBe("");
  });
});
