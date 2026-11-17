import { type Fixture, place } from "./fixture.ts";

/** States an agent can be in, one terminal each, told through hc's `status` events once the screen subscribed. */
const STATES = ["working", "blocked", "done", "idle"] as const;

export const agents: Fixture = {
  build(core) {
    for (const state of STATES) place(core, { space: "w-agents", spaceName: "agents", tab: "t-agents", tabName: "agents", pane: state }, `claude: ${state}\r\n`);
  },
  online(core) {
    STATES.forEach((state, at) => core.emit("status", `t${at + 1}`, { status: { state, app: "claude" } }));
  },
};
