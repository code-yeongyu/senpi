import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ConnectionRoles } from "../../../src/modes/rpc/connection-roles.ts";
import { INTERACTIVE_USER_CAPABILITY } from "../../../src/modes/rpc/custom-capability.ts";
import type { RpcCommand, RpcResponse } from "../../../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { inProcessRuntimeFactory } from "../rpc-inprocess-host-support.ts";

// senpi#3811 re-applied to the split router (senpi#3814): one test per site, each failing if that site's
// per-connection interactive_user binding is dropped.

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function host() {
	const dir = await mkdtemp(join(tmpdir(), "senpi-3811-split-"));
	directories.push(dir);
	const { createRuntime } = inProcessRuntimeFactory();
	const registry = new RpcSessionRegistry({ agentDir: dir, createRuntime });
	const writer = new SessionEventWriter(() => {});
	const bindingRoles: (ConnectionRoles | undefined)[] = [];
	const router = new SessionCommandRouter(registry, writer, { cwd: dir }, async (...args) => {
		bindingRoles.push(args[4]?.connectionRoles);
		return { handle: async () => {}, dispose: async () => {}, cancelPendingExtensionUiRequests: () => {} };
	});
	const connect = (connection: string) =>
		writer.registerConnection(connection, { writeRaw: () => {}, waitForBackpressure: async () => {} });
	const send = (connection: string, command: RpcCommand) =>
		writer.withConnection(connection, () => router.handle(command)) as Promise<RpcResponse | undefined>;
	return { dir, router, writer, bindingRoles, connect, send };
}

it("set_client_info site: a connection cannot flip its declared interactive_user role", async () => {
	const { connect, send } = await host();
	connect("client");
	const declared = await send("client", {
		type: "set_client_info",
		width: 80,
		capabilities: [INTERACTIVE_USER_CAPABILITY],
	});
	const dropped = await send("client", { type: "set_client_info", width: 80, capabilities: [] });
	expect(declared).toMatchObject({ success: true });
	expect(dropped).toMatchObject({ success: false, error: expect.stringContaining("connection_role_fixed") });
});

it("open site: a session binding reads the roles each connection declared at the host", async () => {
	const { dir, connect, send, bindingRoles } = await host();
	connect("client");
	await send("client", { type: "set_client_info", width: 80, capabilities: [INTERACTIVE_USER_CAPABILITY] });
	await send("client", { id: "open", type: "open_session", cwd: dir });
	expect(bindingRoles).toHaveLength(1);
	expect(bindingRoles[0]?.has("client", INTERACTIVE_USER_CAPABILITY)).toBe(true);
	expect(bindingRoles[0]?.has("stranger", INTERACTIVE_USER_CAPABILITY)).toBe(false);
});

it("releaseConnection site: a connection's declared role ends with it", async () => {
	const { dir, router, connect, send, bindingRoles } = await host();
	connect("client");
	await send("client", { type: "set_client_info", width: 80, capabilities: [INTERACTIVE_USER_CAPABILITY] });
	await send("client", { id: "open", type: "open_session", cwd: dir, retain_on_disconnect: true });
	await router.releaseConnection("client");
	expect(bindingRoles[0]?.has("client", INTERACTIVE_USER_CAPABILITY)).toBe(false);
	connect("client");
	expect(await send("client", { type: "set_client_info", width: 80, capabilities: [] })).toMatchObject({
		success: true,
	});
});
