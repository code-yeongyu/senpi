import { expect, it } from "vitest";
import { daemonEnvIsAllowed, daemonEnvOverrides } from "../../src/modes/rpc/host-daemon-env.ts";

it("never lets a daemon inherit one session's browser engine from the process that ensured it", () => {
	expect(daemonEnvIsAllowed("OMO_BROWSER_ENGINE")).toBe(false);
	expect(daemonEnvOverrides({ OMO_BROWSER_ENGINE: "connected", PATH: "/usr/bin" })).toMatchObject({
		OMO_BROWSER_ENGINE: null,
	});
});

it("lets the per-install BrowserSkill location reach a daemon unchanged", () => {
	expect(daemonEnvIsAllowed("BSK_HOME")).toBe(true);
	expect(daemonEnvIsAllowed("BSK_BIN")).toBe(true);
	expect(daemonEnvOverrides({ BSK_HOME: "/opt/bsk", BSK_BIN: "/opt/bsk/bin/bsk" })).not.toHaveProperty(
		"BSK_HOME",
		null,
	);
});

it("still keeps an unrelated BSK_ variable out of a daemon", () => {
	expect(daemonEnvIsAllowed("BSK_TOKEN")).toBe(false);
});
