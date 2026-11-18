/**
 * senpi#6443: the name a connection declared with `set_client_info { client_id }` is forgotten when its socket is
 * gone, whatever that connection held. A long-lived host otherwise keeps one entry for every connection that named
 * itself and left without a session, for as long as the host runs.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RouterContext } from "../../src/modes/rpc/session-router-context.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a dropped connection's client name is forgotten (senpi#6443)", () => {
	it.each([
		["held no session", false],
		["held a session", true],
	])(
		"#given a connection that named itself and %s #when its socket drops #then the host keeps no name for it",
		async (_case, opens) => {
			const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "senpi-client-id-")));
			dirs.push(agentDir);
			await using rig = createInProcessRig(agentDir);
			const context: unknown = Reflect.get(rig.router, "context");
			if (!(context instanceof RouterContext))
				throw new Error("SessionCommandRouter.context is gone; update this test");
			await rig.send("conn-named", { type: "set_client_info", id: "declare", width: 80, client_id: "one-client" });
			if (opens) await rig.open("conn-named", { cwd: agentDir });
			expect(context.clientIds.get("conn-named")).toBe("one-client");

			await rig.drop("conn-named");

			expect(context.clientIds.has("conn-named")).toBe(false);
		},
	);
});
