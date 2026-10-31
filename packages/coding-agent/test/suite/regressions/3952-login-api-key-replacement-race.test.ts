import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRpcConnectionHandler } from "../../../src/modes/rpc/connection-handler.ts";
import { makeHarness, makeSink } from "../rpc-connection-harness.ts";

const PROVIDER = "scripted-oauth";

function registerScriptedOAuth(harness: ReturnType<typeof makeHarness>): void {
	harness.authStorage.registerOAuthProvider(PROVIDER, {
		name: "Scripted OAuth",
		async login() {
			return { type: "oauth", access: "scripted-access", refresh: "scripted-refresh", expires: 4_102_444_800_000 };
		},
		async refresh(credentials) {
			return credentials;
		},
		async toAuth(credentials) {
			return { apiKey: credentials.access };
		},
	});
}

// Guard (senpi#3952): #3486 already narrowed this window to a few microtasks, so these also pass on the
// pre-hardening handler; they pin that each RPC login reports only its own replacement.
describe("RPC logins report only their own replacement (senpi#3952)", () => {
	let tempDir: string;
	let cleanup: (() => void) | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `rpc-login-race-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("an OAuth login that replaces a key while login_api_key awaits its refresh still reports the replacement", async () => {
		const collected = makeSink();
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		registerScriptedOAuth(harness);
		harness.authStorage.set(PROVIDER, { type: "oauth", access: "old", refresh: "old", expires: 4_102_444_800_000 });
		harness.authStorage.takeReplacement(PROVIDER);
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);
		// Hold only login_api_key's refresh: the handler's own startup must finish first.
		await handler.ready;
		const registry = harness.runtimeHost.session.modelRegistry;
		const realRefresh = registry.refresh.bind(registry);
		let releaseKeyRefresh: () => void = () => {};
		const keyRefreshHeld = new Promise<void>((resolve) => {
			releaseKeyRefresh = resolve;
		});
		let markKeyRefreshEntered: () => void = () => {};
		const keyRefreshEntered = new Promise<void>((resolve) => {
			markKeyRefreshEntered = resolve;
		});
		vi.spyOn(registry, "refresh").mockImplementationOnce(async (options) => {
			markKeyRefreshEntered();
			await keyRefreshHeld;
			return realRefresh(options);
		});

		// login_api_key answers only after its refresh, which this test holds open; keep the promise.
		const keyCommand = handler.handleInputLine(
			JSON.stringify({ id: "key", type: "login_api_key", provider: PROVIDER, key: "sk-FAKE-key" }),
		);
		await keyRefreshEntered;
		const oauthEnd = collected.waitFor((message) => message.type === "auth_login_end", 10_000);
		await handler.handleInputLine(JSON.stringify({ id: "oauth", type: "login_start", provider: PROVIDER }));
		const end = await oauthEnd;
		releaseKeyRefresh();
		await keyCommand;

		expect(await collected.waitFor((message) => message.id === "key")).toMatchObject({
			success: true,
			data: { replaced: "oauth" },
		});
		expect(end).toMatchObject({ provider: PROVIDER, success: true, replaced: "api_key" });
		await handler.dispose();
	});

	it("an OAuth login of the same kind never reports a replacement left by an earlier caller", async () => {
		const collected = makeSink();
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		registerScriptedOAuth(harness);
		harness.authStorage.set(PROVIDER, { type: "api_key", key: "sk-FAKE-earlier" });
		harness.authStorage.set(PROVIDER, {
			type: "oauth",
			access: "direct",
			refresh: "direct",
			expires: 4_102_444_800_000,
		});
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);

		const ended = collected.waitFor((message) => message.type === "auth_login_end");
		await handler.handleInputLine(JSON.stringify({ id: "again", type: "login_start", provider: PROVIDER }));
		const end = await ended;
		expect(end).toMatchObject({ provider: PROVIDER, success: true });
		expect(end).not.toHaveProperty("replaced");
		expect(end).not.toHaveProperty("backupPath");
		await handler.dispose();
	});
});
