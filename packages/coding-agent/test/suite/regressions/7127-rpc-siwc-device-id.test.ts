import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createRpcConnectionHandler } from "../../../src/modes/rpc/connection-handler.ts";
import { makeHarness, makeSink } from "../rpc-connection-harness.ts";

// senpi#7127: Sign in with ChatGPT started over RPC must reach OpenAI with this installation's device id,
// exactly as the TUI does, instead of failing before any URL is shown.

let tempDir = "";
let cleanup: (() => void) | undefined;
beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "senpi-7127-"));
});
afterEach(() => {
	cleanup?.();
	cleanup = undefined;
	rmSync(tempDir, { recursive: true, force: true });
});

it("a ChatGPT sign-in over RPC sends the installation's device id and asks for the redirect URL", async () => {
	const collected = makeSink();
	const harness = makeHarness(tempDir);
	cleanup = harness.cleanup;
	const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);
	const route = collected.waitFor((message) => message.type === "extension_ui_request" && message.method === "select");

	await handler.handleInputLine(
		JSON.stringify({ id: "start", type: "login_start", provider: "chatgpt-subscription" }),
	);
	const select = await route;
	const url = collected.waitFor((message) => message.type === "auth_login_url");
	const ended = collected.waitFor((message) => message.type === "auth_login_end");
	const manual = collected.waitFor((message) => message.type === "extension_ui_request" && message.method === "input");
	await handler.handleInputLine(
		JSON.stringify({ type: "extension_ui_response", id: select.id, value: "Continue with ChatGPT" }),
	);

	const first = await Promise.race([url, ended]);
	expect(first).toMatchObject({ type: "auth_login_url", provider: "chatgpt-subscription" });
	const query = new URL(String(first.url)).searchParams;
	const deviceId = harness.runtimeHost.session.settingsManager.getOrCreateDeviceId();
	expect(deviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
	expect({
		clientId: query.get("client_id"),
		hostId: query.get("ext_agent_host_id"),
	}).toEqual({ clientId: "dynamic_agent_client", hostId: `urn:uuid:${deviceId.toLowerCase()}` });
	await manual;

	await handler.handleInputLine(
		JSON.stringify({ id: "cancel", type: "login_cancel", provider: "chatgpt-subscription" }),
	);
	expect(await ended).toMatchObject({ provider: "chatgpt-subscription", success: false });
	await handler.dispose();
});
