import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRpcConnectionHandler } from "../../../src/modes/rpc/connection-handler.ts";
import { makeHarness, makeSink } from "../rpc-connection-harness.ts";

/**
 * code-yeongyu/omo-desktop-app#4385 item 5: a Kimi Code API key saved through RPC `login_api_key`
 * carried only the key, so a key from kimi.ai was sent to kimi.com. The CLI's `/login` asks the
 * region first and stores it with the key; the RPC now takes the same region and stores the same
 * credential.
 */
describe("a Kimi Code API key saved with its region over RPC (omo-desktop-app#4385)", () => {
	let tempDir: string;
	let cleanup: () => void = () => {};

	beforeEach(() => {
		tempDir = join(tmpdir(), `senpi-4385-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		cleanup();
		rmSync(tempDir, { recursive: true, force: true });
	});

	const send = async (command: Record<string, unknown>) => {
		const collected = makeSink();
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);
		await handler.handleInputLine(JSON.stringify({ id: "key", ...command }));
		const response = await collected.waitFor((message) => message.id === "key");
		const stored = await harness.authStorage.read(String(command.provider));
		await handler.dispose();
		return { response, stored, harness };
	};

	it("stores exactly what the CLI's /login stores for the same region and key", async () => {
		const cliHarness = makeHarness(join(tempDir, "cli"));
		await cliHarness.runtimeHost.session.modelRuntime.login("kimi-coding", "api_key", {
			signal: new AbortController().signal,
			prompt: async (prompt) => (prompt.type === "select" ? "global" : "sk-kimi-synthetic"),
			notify: () => {},
		});
		const fromCli = await cliHarness.authStorage.read("kimi-coding");
		cliHarness.cleanup();

		const { response, stored } = await send({
			type: "login_api_key",
			provider: "kimi-coding",
			key: "sk-kimi-synthetic",
			region: "global",
		});
		expect(response).toMatchObject({ success: true });
		expect(stored).toEqual({ type: "api_key", key: "sk-kimi-synthetic", env: { KIMI_CODE_REGION: "global" } });
		expect(stored).toEqual(fromCli);
	});

	it("keeps a key saved without a region exactly as before", async () => {
		const { response, stored } = await send({ type: "login_api_key", provider: "kimi-coding", key: "sk-kimi-plain" });
		expect(response).toMatchObject({ success: true });
		expect(stored).toEqual({ type: "api_key", key: "sk-kimi-plain" });
	});

	it("refuses a region the provider does not offer and stores nothing", async () => {
		const { response, stored } = await send({
			type: "login_api_key",
			provider: "kimi-coding",
			key: "sk-kimi-synthetic",
			region: "moon",
		});
		expect(response).toMatchObject({ success: false });
		expect(stored).toBeUndefined();
	});

	it("refuses a region for a provider whose API key has no region", async () => {
		const { response, stored } = await send({
			type: "login_api_key",
			provider: "openrouter",
			key: "sk-or-synthetic",
			region: "global",
		});
		expect(response).toMatchObject({ success: false });
		expect(stored).toBeUndefined();
	});

	it("refuses a region the host's environment overrides, and accepts the one it pins", async () => {
		vi.stubEnv("KIMI_CODE_REGION", "mainland-cn");
		const unknown = await send({
			type: "login_api_key",
			provider: "kimi-coding",
			key: "sk-kimi-synthetic",
			region: "moon",
		});
		expect(unknown.response).toMatchObject({ success: false });
		expect(unknown.stored).toBeUndefined();

		const other = await send({
			type: "login_api_key",
			provider: "kimi-coding",
			key: "sk-kimi-synthetic",
			region: "global",
		});
		expect(other.response).toMatchObject({ success: false });
		expect(other.stored).toBeUndefined();

		const pinned = await send({
			type: "login_api_key",
			provider: "kimi-coding",
			key: "sk-kimi-synthetic",
			region: "mainland-cn",
		});
		expect(pinned.response).toMatchObject({ success: true });
		expect(pinned.stored).toEqual({
			type: "api_key",
			key: "sk-kimi-synthetic",
			env: { KIMI_CODE_REGION: "mainland-cn" },
		});
	});
});
