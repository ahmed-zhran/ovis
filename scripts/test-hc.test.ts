import { afterAll, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedHcEnv, stopIsolatedCore, stopTestCores } from "./test-hc.ts";

// A stand-in hc that writes down how it was run: no real core is started or stopped.
const root = mkdtempSync(join(tmpdir(), "ovis-test-hc-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const record = join(root, "ran");
const bin = join(root, "hc");
writeFileSync(bin, `#!/bin/sh\nprintf '%s|%s|%s\\n' "$*" "$HC_SOCKET" "$OVIS_CANARY" > ${JSON.stringify(record)}\n`);
chmodSync(bin, 0o755);

it("never stops a core when the test's own core was never set up", async () => {
  await stopIsolatedCore(bin, {});
  expect(existsSync(record)).toBe(false);
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A stand-in hc whose status names `pids` (the first as the core, the second as its holder; none: it prints nothing) and whose stop leaves them. */
function naming(name: string, [core, holder]: number[]): string {
  const path = join(root, name);
  const status = core === undefined ? "" : `echo '{"pid":${core},"holder":${holder === undefined ? "null" : `{"pid":${holder}}`}}'`;
  writeFileSync(path, `#!/bin/sh\n[ "$1 $2" = "server status" ] && ${status || ":"}\nexit 0\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A sleep of the test's own, started in `env` and outside this process's group, as a core's daemon is. */
const sleeper = async (env: Record<string, string>) =>
  Number((await new Response(Bun.spawn(["sh", "-c", "sleep 60 >/dev/null 2>&1 & echo $!"], { env, stdout: "pipe" }).stdout).text()).trim());

// a pid is proven to be a core's only through /proc: where there is none, nothing is killed
it.skipIf(!existsSync("/proc/self/stat"))("reads the holder again before a stop, and kills and names what outlived the stop", async () => {
  // started in the core's environment, they stand in for the core and the holder it got after its start; this stand-in's stop leaves both
  const env = isolatedHcEnv(join(root, "stuck"));
  const [core, holder] = [await sleeper(env), await sleeper(env)];
  expect(await stopTestCores(naming("hc-stuck", [core, holder]), [{ env, pids: [core] }], 200)).toEqual({ stopped: [0], killed: [core, holder], unproven: [], socketsLeft: [] });
  expect([core, holder].filter(alive)).toEqual([]);
});

it.skipIf(!existsSync("/proc/self/stat"))("ends what one core left before the next core is stopped, as a running first core would start the next again", async () => {
  const [first, next] = [isolatedHcEnv(join(root, "first")), isolatedHcEnv(join(root, "next"))];
  const left = await sleeper(first);
  const seen = join(root, "seen-at-next-stop");
  // its status names the first core's leftover; its stop of the next core writes down whether that leftover still runs
  const bin = join(root, "hc-two");
  writeFileSync(bin, `#!/bin/sh\n[ "$1 $2" = "server status" ] && echo '{"pid":${left},"holder":null}'\nif [ "$1 $2" = "server stop" ] && [ "$HC_SOCKET" = "${next["HC_SOCKET"]}" ]; then if kill -0 ${left} 2>/dev/null; then echo running > ${JSON.stringify(seen)}; else echo gone > ${JSON.stringify(seen)}; fi; fi\nexit 0\n`);
  chmodSync(bin, 0o755);
  expect(await stopTestCores(bin, [{ env: first, pids: [left] }, { env: next, pids: [] }], 200)).toEqual({ stopped: [0, 0], killed: [left], unproven: [], socketsLeft: [] });
  expect(readFileSync(seen, "utf8")).toBe("gone\n");
});

it("kills no recorded pid that is now a process of another core, and names it unproven", async () => {
  const env = isolatedHcEnv(join(root, "intended"));
  // what a recorded pid would be once its number went to another core: the status names it, so its start time is recorded
  const stranger = Bun.spawn(["sleep", "30"], { env: isolatedHcEnv(join(root, "other")) });
  try {
    const result = await stopTestCores(naming("hc-other", [stranger.pid]), [{ env, pids: [stranger.pid] }], 200);
    expect({ result, alive: alive(stranger.pid) }).toEqual({ result: { stopped: [0], killed: [], unproven: [stranger.pid], socketsLeft: [] }, alive: true });
  } finally {
    stranger.kill();
    await stranger.exited;
  }
});

it("kills no pid that no status named, even one started in the core's own environment, and names it unproven", async () => {
  const env = isolatedHcEnv(join(root, "unnamed"));
  // this stand-in's status prints nothing, so no start time is recorded for the pid the test passes in
  const stranger = Bun.spawn(["sleep", "30"], { env });
  try {
    const result = await stopTestCores(naming("hc-silent", []), [{ env, pids: [stranger.pid] }], 200);
    expect({ result, alive: alive(stranger.pid) }).toEqual({ result: { stopped: [0], killed: [], unproven: [stranger.pid], socketsLeft: [] }, alive: true });
  } finally {
    stranger.kill();
    await stranger.exited;
  }
});

it("refuses, before any hc command, an environment that names no core of its own", async () => {
  rmSync(record, { force: true });
  // without HC_SOCKET and HC_SESSION, hc server stop there would stop the user's default core
  const users = { PATH: "/usr/bin:/bin", HOME: join(root, "home") };
  expect(await stopTestCores(bin, [{ env: users, pids: [] }]).then(() => "stopped", (error: unknown) => (error as Error).message)).toContain("name none");
  // nor is an isolated core stopped first when another of the list is not one
  expect(await stopTestCores(bin, [{ env: isolatedHcEnv(join(root, "own")), pids: [] }, { env: users, pids: [] }]).then(() => "stopped", () => "refused")).toBe("refused");
  expect(existsSync(record)).toBe(false);
});

it("waits for the socket of a core it has no pid for, and names one that stays", async () => {
  const env = isolatedHcEnv(join(root, "pidless"));
  mkdirSync(join(root, "pidless", "run"), { recursive: true });
  // a core that goes a moment after its stop answered, and one whose stop leaves its socket
  const late = join(root, "hc-late");
  writeFileSync(late, `#!/bin/sh\n(sleep 0.3; rm -f "$HC_SOCKET") >/dev/null 2>&1 &\nexit 0\n`);
  const stays = join(root, "hc-stays");
  writeFileSync(stays, "#!/bin/sh\nexit 0\n");
  for (const stand of [late, stays]) chmodSync(stand, 0o755);
  writeFileSync(env["HC_SOCKET"]!, "");
  expect(await stopTestCores(late, [{ env, pids: [] }])).toEqual({ stopped: [0], killed: [], unproven: [], socketsLeft: [] });
  expect(existsSync(env["HC_SOCKET"]!)).toBe(false);
  writeFileSync(env["HC_SOCKET"]!, "");
  expect(await stopTestCores(stays, [{ env, pids: [] }], 200)).toEqual({ stopped: [0], killed: [], unproven: [], socketsLeft: [env["HC_SOCKET"]!] });
});

it("stops the test's own core, in its environment alone", async () => {
  process.env["OVIS_CANARY"] = "inherited";
  try {
    const env = isolatedHcEnv(join(root, "core"));
    await stopIsolatedCore(bin, env);
    expect(readFileSync(record, "utf8")).toBe(`server stop|${env["HC_SOCKET"]}|\n`);
  } finally {
    delete process.env["OVIS_CANARY"];
  }
});
