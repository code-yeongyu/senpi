/**
 * senpi#6443: a connection's client name is kept only from a declaration the host accepted, and only until that
 * connection is released. A refused declaration that left its name behind would count its sender as the holder of
 * sessions it does not hold; so would a name that outlived a `detach_connection`.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RouterContext } from "../../src/modes/rpc/session-router-context.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";

const CONNECTION = "conn-named";
const NAMED = { type: "set_client_info", width: 80, client_id: "one-client" } as const;

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function host() {
	const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "senpi-client-id-")));
	dirs.push(agentDir);
	const rig = createInProcessRig(agentDir);
	const context: unknown = Reflect.get(rig.router, "context");
	if (!(context instanceof RouterContext)) throw new Error("SessionCommandRouter.context is gone; update this test");
	return { rig, agentDir, names: context.clientIds };
}

describe("a client name is recorded only by an accepted declaration (senpi#6443)", () => {
	it("#given a declaration that names a session this host does not have #then it is refused and no name is kept", async () => {
		const { rig, names } = host();
		await using _host = rig;

		const refused = await rig.send(CONNECTION, { ...NAMED, id: "declare", sessionId: "no-such-session" });

		expect(refused).toMatchObject({ success: false });
		expect(names.has(CONNECTION)).toBe(false);
	});

	it("#given a connection whose role is fixed #when a declaration that changes the role also carries a name #then it is refused connection_role_fixed and no name is kept", async () => {
		const { rig, names } = host();
		await using _host = rig;
		const first = await rig.send(CONNECTION, {
			type: "set_client_info",
			id: "role",
			width: 80,
			capabilities: ["interactive_user"],
		});
		expect(first).toMatchObject({ success: true });

		const refused = await rig.send(CONNECTION, { ...NAMED, id: "declare", capabilities: ["task_parent"] });

		expect(refused).toMatchObject({ success: false, error: expect.stringContaining("connection_role_fixed") });
		expect(names.has(CONNECTION)).toBe(false);
	});

	it("#given a connection that named itself #when it sends detach_connection #then the name is gone with that incarnation", async () => {
		const { rig, names } = host();
		await using _host = rig;
		expect(await rig.send(CONNECTION, { ...NAMED, id: "declare" })).toMatchObject({ success: true });
		expect(names.get(CONNECTION)).toBe("one-client");

		const detached = await rig.send(CONNECTION, { type: "detach_connection", id: "detach" });

		expect(detached).toMatchObject({ success: true });
		expect(names.has(CONNECTION)).toBe(false);
	});

	it("#given a draining host and a connection that named itself and holds a session #when its socket drops #then the host keeps no name for it", async () => {
		const { rig, agentDir, names } = host();
		await using _host = rig;
		await rig.send(CONNECTION, { ...NAMED, id: "declare" });
		await rig.open(CONNECTION, { cwd: agentDir });
		expect(names.get(CONNECTION)).toBe("one-client");
		rig.router.beginDrain();

		await rig.drop(CONNECTION);

		expect(names.has(CONNECTION)).toBe(false);
	});
});
