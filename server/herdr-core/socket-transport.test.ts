import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const hcLog = join(dir, "hc.log");
  const NAMES = ["PATH", "HOME", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "HC_SOCKET", "HC_SESSION", "HERDR_TEST_SESSION", "HERDR_TEST_LIVE", "OVIS_ALLOW_LIVE_HERDR"] as const;
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

  beforeAll(async () => {
    // an hc first on PATH that only records its arguments: a transport that started one would leave a line
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "hc"), `#!/bin/sh\necho "$*" >> '${hcLog}'\n`);
    chmodSync(join(dir, "bin", "hc"), 0o755);
    process.env["PATH"] = `${join(dir, "bin")}:${saved["PATH"] ?? "/usr/bin:/bin"}`;
    // the stand-in is what a spawn in this environment finds (as spawnHcConnect's), so an empty log below means nothing ran it
    expect(await Bun.spawn(["hc", "control"], { env: process.env, stdout: "ignore", stderr: "ignore" }).exited).toBe(0);
    expect(hcRuns()).toBe("control\n");
    rmSync(hcLog);
  });

  afterEach(() => {
    for (const transport of transports.splice(0)) transport.kill();
    for (const listener of listeners.splice(0)) listener.stop(true);
    for (const name of NAMES) if (name !== "PATH") { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  });

  afterAll(() => {
    process.env["PATH"] = saved["PATH"];
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

  it("missing socket file gives no_core", async () => {
    expect(await failureOf(join(dir, "absent.sock"))).toBe("no_core");
    expect(hcRuns()).toBe("");
  });

  it("stale socket file refuses", async () => {
    const live = join(dir, "live.sock");
    const stale = join(dir, "stale.sock");
    const core = listen(live);
    // a stopped listener removes its file; a second name keeps it, as a core that was killed leaves its socket
    linkSync(live, stale);
    core.listener.stop(true);
    expect(existsSync(stale)).toBe(true);
    expect(await failureOf(stale)).toBe("no_core");
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

  it("the test-session guard refuses the user's default socket", async () => {
    // the user's default socket is under this test's own folders: a guard that let it through finds no core there
    process.env["HOME"] = join(dir, "home");
    process.env["XDG_RUNTIME_DIR"] = join(dir, "run");
    process.env["XDG_CONFIG_HOME"] = join(dir, "config");
    for (const name of ["HC_SOCKET", "HC_SESSION", "HERDR_TEST_LIVE", "OVIS_ALLOW_LIVE_HERDR"]) delete process.env[name];
    process.env["HERDR_TEST_SESSION"] = "ovis-test-guard";
    const userDefault = coreSocket().path;
    expect(userDefault.startsWith(dir)).toBe(true);
    expect(await failureOf()).toBe("live_core_refused");
    // another spelling of the same socket
    expect(await failureOf(join(dir, "run", "herdr-core", "..", "herdr-core", "default.sock"))).toBe("live_core_refused");
    // a core of the test's own is not the user's
    expect(await failureOf(join(dir, "own.sock"))).toBe("no_core");
    // said out loud, the user's own core may be reached
    process.env["OVIS_ALLOW_LIVE_HERDR"] = "1";
    expect(await failureOf(userDefault)).toBe("no_core");
    expect(hcRuns()).toBe("");
  });
});
