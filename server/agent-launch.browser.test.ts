import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetBuiltInBrowserToken, readBrowserToolSetting, withBrowserTool } from "./agent-launch.ts";

const dirs: string[] = [];
afterEach(() => {
  readBrowserToolSetting(() => undefined, tmpdir(), null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function host(enabled: boolean, socket: string | null = "/run/ovis/broker.sock") {
  const dir = mkdtempSync(join(tmpdir(), "ovis-builtin-tool-"));
  dirs.push(dir);
  const tokensDir = join(dir, "browser-tokens");
  readBrowserToolSetting(() => ({ claude: "ovis", codex: "ovis" }), join(dir, "browser tools"), { socket, enabled: () => enabled, tokensDir, command: ["/opt/ovis/ovis-server", "browser-mcp"] });
  return { dir, tokensDir };
}

describe("the built-in browser as an agent's browser tool", () => {
  it("gives a pane's agent its own token and the app's socket, and takes the token back when the pane goes", () => {
    const { dir, tokensDir } = host(true);
    const args = withBrowserTool("claude", ["--model", "opus"], "linux", "p7")!;
    expect(args.slice(0, 3)).toEqual(["--model", "opus", "--mcp-config"]);
    const config = JSON.parse(readFileSync(args[3]!, "utf8"));
    expect(args[3]).toBe(join(dir, "browser tools", "claude-ovis-p7.json"));
    const token = join(tokensDir, "p7.token");
    expect(config.mcpServers["ovis-browser"]).toEqual({ type: "stdio", command: "/opt/ovis/ovis-server", args: ["browser-mcp", "--socket", "/run/ovis/broker.sock", "--token-file", token] });
    if (process.platform !== "win32") expect(statSync(token).mode & 0o777).toBe(0o600);
    const first = readFileSync(token, "utf8");
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    withBrowserTool("claude", [], "linux", "p7");
    expect(readFileSync(token, "utf8")).not.toBe(first);
    forgetBuiltInBrowserToken("p7");
    expect(existsSync(token)).toBe(false);
  });

  it("passes Codex the same as -c settings", () => {
    const { tokensDir } = host(true);
    const args = withBrowserTool("codex", ["--", "do it"], "linux", "p8")!;
    expect(args).toEqual(["-c", "mcp_servers.ovis-browser.command='/opt/ovis/ovis-server'", "-c", `mcp_servers.ovis-browser.args=['browser-mcp','--socket','/run/ovis/broker.sock','--token-file','${join(tokensDir, "p8.token")}']`, "--", "do it"]);
  });

  it("adds nothing while the setting is off, outside the desktop app, or without a pane", () => {
    host(false);
    expect(withBrowserTool("claude", ["--x"], "linux", "p1")).toEqual(["--x"]);
    const { tokensDir } = host(true, null);
    expect(withBrowserTool("claude", ["--x"], "linux", "p1")).toEqual(["--x"]);
    host(true);
    expect(withBrowserTool("claude", ["--x"], "linux")).toEqual(["--x"]);
    expect(withBrowserTool("claude", ["--x"], "linux", "../p1")).toEqual(["--x"]);
    expect(existsSync(tokensDir)).toBe(false);
  });
});
