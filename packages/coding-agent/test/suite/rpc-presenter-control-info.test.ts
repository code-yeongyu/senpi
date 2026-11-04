/**
 * senpi#4249 R-1b (d2): `mcp_presenter_control_info` tells the host's own relay where the presenter control endpoint
 * listens. Security contract: only a connection that proved the launch key and is not delegated gets an answer, and
 * the endpoint appears only while an account-enrolling control listens; every other caller is refused
 * `presenter_not_authorized` (a delegated one in the private reply shape).
 */
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { PresenterAccountAuthority } from "../../src/modes/rpc/mcp-presenter-account.ts";
import {
	type McpPresenterControlStart,
	startMcpPresenterControl,
} from "../../src/modes/rpc/mcp-presenter-control-start.ts";
import { RPC_LAUNCH_PROOF_RECORD } from "../../src/modes/rpc/rpc-auth-proof.ts";
import { type CorePeer, declare, startCore, type WireRecord } from "./rpc-delegated-presenter-support.ts";

const account: PresenterAccountAuthority = {
	hostAccount: () => "account",
	verify: async () => {
		throw new Error("control info never verifies an attestation");
	},
	onAccountChange: () => () => {},
};

let core: Awaited<ReturnType<typeof startCore>>;
const controls: McpPresenterControlStart[] = [];
beforeEach(async () => {
	core = await startCore();
});
afterEach(async () => {
	for (const { control } of controls.splice(0)) control.dispose();
	await core.dispose();
});

async function listen(options: Parameters<typeof startMcpPresenterControl>[1]): Promise<string> {
	const started = await startMcpPresenterControl(core.writer, { enforcement: true, ...options });
	if (!started) throw new Error("no presenter control endpoint");
	controls.push(started);
	return started.control.path;
}

async function ask(peer: CorePeer, id = "info"): Promise<WireRecord> {
	const answered = peer.written((line) => line.id === id);
	await peer.send({ id, type: "mcp_presenter_control_info" });
	return answered;
}

const refusal = (id: string) => ({
	id,
	type: "response",
	command: "mcp_presenter_control_info",
	success: false,
	error: expect.stringMatching(/^presenter_not_authorized: /),
	errorCode: "presenter_not_authorized",
});

it("a launch-proven non-delegated connection gets the account control endpoint", async () => {
	const path = await listen({ account });
	expect(await ask(core.peer("relay", { launchProof: "proven" }))).toEqual({
		id: "info",
		type: "response",
		command: "mcp_presenter_control_info",
		success: true,
		data: { controlEndpoint: path },
	});
});

it("a connection proven in band is answered only after its proof record", async () => {
	const path = await listen({ account });
	const relay = core.peer("relay", { launchProof: "in_band" });
	expect(await ask(relay, "early")).toEqual(refusal("early"));
	await relay.send({ type: RPC_LAUNCH_PROOF_RECORD });
	expect(await ask(relay, "proven")).toMatchObject({ success: true, data: { controlEndpoint: path } });
});

it("a connection that never proved the launch key is refused", async () => {
	await listen({ account });
	expect(await ask(core.peer("keyless"))).toEqual(refusal("info"));
});

it("a delegated connection is refused in the private reply shape, even with every grant", async () => {
	await listen({ account });
	const viewer = core.peer("viewer", { launchProof: "proven" });
	expect(await declare(viewer, ["observe", "drive", "answer", "thread", "device_admin"])).toMatchObject({
		success: true,
	});
	expect(await ask(viewer)).toEqual({ type: "mcp_form_reply", id: "info", error: "presenter_not_authorized" });
	expect(viewer.answers("info")).toHaveLength(1);
});

it.each([
	["no presenter control at all", async () => {}],
	["a control without an account authority", () => listen({ bootstrap: new PassThrough() })],
])("with %s the reply carries no controlEndpoint key", async (_name, setup) => {
	await setup();
	expect(await ask(core.peer("relay", { launchProof: "proven" }))).toEqual({
		id: "info",
		type: "response",
		command: "mcp_presenter_control_info",
		success: true,
		data: {},
	});
});

it("asking for control info counts as a record, so a later first declaration is late", async () => {
	await listen({ account });
	const relay = core.peer("relay", { launchProof: "proven" });
	expect(await ask(relay)).toMatchObject({ success: true });
	expect(await declare(relay, ["observe", "answer"])).toMatchObject({
		success: false,
		command: "declare_delegation",
		errorCode: "delegation_late",
	});
	expect(await ask(relay, "still-local")).toMatchObject({
		success: true,
		data: { controlEndpoint: expect.any(String) },
	});
});

it("a disposed control is no longer reported", async () => {
	await listen({ account });
	const relay = core.peer("relay", { launchProof: "proven" });
	expect(await ask(relay, "listening")).toMatchObject({ data: { controlEndpoint: expect.any(String) } });
	for (const { control } of controls.splice(0)) control.dispose();
	expect(await ask(relay, "disposed")).toMatchObject({ success: true, data: {} });
});
