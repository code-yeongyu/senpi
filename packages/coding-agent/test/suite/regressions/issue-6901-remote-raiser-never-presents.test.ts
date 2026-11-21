/**
 * senpi#6901 review H1: a connection that speaks for another device (a declared `remoteOrigin` or a delegation) never
 * presents or answers a grant select, even when it advertises `grant_select` and raised the request itself; otherwise
 * a remote requester approves its own user-skill write. Checked on the worker runtime's host route and on the classic
 * handler that presents for itself.
 */
import { afterEach, expect, it } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { getMcpGrantPresentation } from "../../../src/core/mcp-grant-presentations.ts";
import { createRpcConnectionHandler, type RpcConnectionHandler } from "../../../src/modes/rpc/connection-handler.ts";
import { createHarness, type Harness } from "../harness.ts";
import { ORIGIN, presenterHost, runCleanups, SESSION } from "../rpc-presenter-routing-harness.ts";

let harness: Harness | undefined;
let handler: RpcConnectionHandler | undefined;

afterEach(async () => {
	await handler?.dispose();
	harness?.cleanup();
	handler = undefined;
	harness = undefined;
	await runCleanups();
});

it("worker route: a remote or delegated raiser with grant_select is never the grant's presenter", async () => {
	const h = await presenterHost();
	await h.connect("remote", "remote", ["grant_select"]);
	await h.connect("delegated", "delegated", ["grant_select"]);
	const cancelled: string[] = [];
	for (const raiser of ["remote", "delegated"])
		expect(h.writer.routeWorkerGrant(SESSION, `own-${raiser}`, raiser, [], () => cancelled.push(raiser))).toEqual({
			accepted: false,
		});
	expect(cancelled).toEqual(["remote", "delegated"]);

	await h.connect("local", "local", ["grant_select"]);
	expect(h.writer.routeWorkerGrant(SESSION, "own-remote-2", "remote", [], () => {})).toEqual({
		accepted: true,
		connection: "local",
	});
	expect(h.writer.acceptWorkerGrantResponse(SESSION, "own-remote-2", "remote")).toBe(false);
	expect(h.writer.acceptWorkerGrantResponse(SESSION, "own-remote-2", "local")).toBe(true);
});

async function classicHandler(): Promise<{ session: Harness["session"]; send: (record: object) => Promise<void> }> {
	harness = await createHarness();
	const runtime = {
		session: harness.session,
		newSession: async () => ({ cancelled: true }),
		switchSession: async () => ({ cancelled: true }),
		fork: async () => ({ cancelled: true, selectedText: "" }),
		dispose: async () => {},
		setRebindSession: () => {},
	} as unknown as AgentSessionRuntime;
	handler = createRpcConnectionHandler(
		runtime,
		{ writeRaw: () => {}, waitForBackpressure: async () => {} },
		{ disposeRuntime: false, capabilities: [] },
	);
	await handler.ready;
	const active = handler;
	return { session: harness.session, send: async (record) => active.handleInputLine(JSON.stringify(record)) };
}

it("classic handler: a connection that declares a remoteOrigin stops presenting grants", async () => {
	const { session, send } = await classicHandler();
	await send({ type: "set_client_info", id: "local", capabilities: ["grant_select"] });
	expect(getMcpGrantPresentation(session.sessionId)).toBeDefined();
	await send({ type: "set_client_info", id: "remote", capabilities: ["grant_select"], remoteOrigin: ORIGIN });
	expect(getMcpGrantPresentation(session.sessionId)).toBeUndefined();
});
