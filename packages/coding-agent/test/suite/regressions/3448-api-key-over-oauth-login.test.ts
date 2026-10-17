import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { createRpcConnectionHandler } from "../../../src/modes/rpc/connection-handler.ts";
import { makeHarness, makeSink } from "../rpc-connection-harness.ts";

/**
 * senpi#3448 (omo-desktop-app#2793): saving an API key for a provider that already held an
 * OAuth login answered success, but the key was appended to the OAuth pool where it could never
 * be used, and get_auth_providers kept the api_key row unconfigured. The desktop hides that old
 * OAuth row, so the card read "Not connected" with no error.
 */
describe("an API key saved over an OAuth login (senpi#3448)", () => {
	let tempDir: string;
	let cleanup: () => void = () => {};
	const oauth = { type: "oauth", access: "old-access", refresh: "old-refresh", expires: 4_102_444_800_000 } as const;

	beforeEach(() => {
		tempDir = join(tmpdir(), `senpi-3448-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		cleanup();
		rmSync(tempDir, { recursive: true, force: true });
	});

	const backups = (authPath: string) =>
		readdirSync(dirname(authPath))
			.filter((name) => name.startsWith("auth.json.backup-"))
			.map((name) => JSON.parse(readFileSync(join(dirname(authPath), name), "utf-8")) as Record<string, unknown>);

	it("uses the key, lights only the api_key row, says what it replaced, and backs up the login", async () => {
		const collected = makeSink();
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);
		harness.authStorage.set("openrouter", oauth);

		await handler.handleInputLine(
			JSON.stringify({ id: "key", type: "login_api_key", provider: "openrouter", key: "sk-scripted" }),
		);
		const saved = await collected.waitFor((message) => message.id === "key");
		expect(saved).toMatchObject({ success: true, data: { replaced: "oauth" } });

		await handler.handleInputLine(JSON.stringify({ id: "rows", type: "get_auth_providers" }));
		const response = await collected.waitFor((message) => message.id === "rows");
		const rows = (response.data as { providers: Array<{ id: string; authType: string; status: unknown }> }).providers
			.filter((row) => row.id === "openrouter")
			.map((row) => [row.authType, row.status]);
		expect(Object.fromEntries(rows)).toEqual({
			oauth: { configured: false },
			api_key: { configured: true, source: "stored" },
		});

		expect(await harness.authStorage.read("openrouter")).toEqual({ type: "api_key", key: "sk-scripted" });
		expect(
			backups(harness.authPath).some((backup) => JSON.stringify(backup.openrouter) === JSON.stringify(oauth)),
		).toBe(true);
		await handler.dispose();
	});

	it("answers without `replaced` when nothing of another kind was stored", async () => {
		const collected = makeSink();
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);

		await handler.handleInputLine(
			JSON.stringify({ id: "key", type: "login_api_key", provider: "openrouter", key: "sk-scripted" }),
		);
		const saved = await collected.waitFor((message) => message.id === "key");
		expect(saved).toMatchObject({ success: true });
		expect((saved.data as { replaced?: unknown } | undefined)?.replaced).toBeUndefined();
		await handler.dispose();
	});

	it("an interactive /login of the other kind keeps the previous credential recoverable and says so (#3486 review)", async () => {
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		harness.authStorage.set("openrouter", oauth);

		await harness.runtimeHost.session.modelRuntime.login("openrouter", "api_key", {
			signal: new AbortController().signal,
			prompt: async () => "sk-typed-in-tui",
			notify: () => {},
		});

		// Then the new key is used, the OAuth login is in a backup, and the replacement is reported once
		expect(await harness.authStorage.read("openrouter")).toEqual({ type: "api_key", key: "sk-typed-in-tui" });
		const replacement = harness.authStorage.takeReplacement("openrouter");
		expect(replacement?.replaced).toBe("oauth");
		expect(replacement?.backupPath).toBeDefined();
		const backup = JSON.parse(readFileSync(replacement?.backupPath ?? "", "utf-8")) as Record<string, unknown>;
		expect(backup.openrouter).toEqual(oauth);
		expect(harness.authStorage.takeReplacement("openrouter")).toBeUndefined();
	});

	it("never switches a mixed pool's billing credential on load; it reports the unused key instead (#3486 review)", () => {
		const authPath = join(tempDir, "agent", "auth.json");
		mkdirSync(dirname(authPath), { recursive: true });
		const mixed = {
			openrouter: {
				...oauth,
				accounts: [
					{
						name: "default",
						source: "login",
						access: "old-access",
						refresh: "old-refresh",
						expires: oauth.expires,
					},
					{ name: "login-2", source: "login", key: "sk-saved-later" },
				],
			},
		};
		writeFileSync(authPath, JSON.stringify(mixed));

		const storage = AuthStorage.create(authPath);

		// Then the OAuth login that pays today stays in use, nothing is deleted, and the user is told what to do
		expect(storage.get("openrouter")?.type).toBe("oauth");
		expect(JSON.parse(readFileSync(authPath, "utf-8"))).toEqual(mixed);
		const notices = storage.pendingNotices().map((notice) => notice.message);
		expect(notices.some((message) => message.includes("openrouter") && message.includes("/login"))).toBe(true);
	});

	it("raises the mixed-pool notice once per change, not on every launch (#3486 review)", () => {
		const authPath = join(tempDir, "agent", "auth.json");
		mkdirSync(dirname(authPath), { recursive: true });
		const slots = [
			{ name: "default", source: "login", access: "old-access", refresh: "old-refresh", expires: oauth.expires },
			{ name: "login-2", source: "login", key: "sk-saved-later" },
		];
		writeFileSync(authPath, JSON.stringify({ openrouter: { ...oauth, accounts: slots } }));

		const first = AuthStorage.create(authPath).pendingNotices();
		expect(first.map((notice) => notice.provider)).toEqual(["openrouter"]);
		AuthStorage.create(authPath).markNoticesSeen(first.map((notice) => notice.id));

		// Seen: a later launch stays quiet
		expect(AuthStorage.create(authPath).pendingNotices()).toEqual([]);

		// A new unused key is a new change, so it is raised again
		writeFileSync(
			authPath,
			JSON.stringify({
				openrouter: { ...oauth, accounts: [...slots, { name: "login-3", source: "login", key: "sk-newer" }] },
			}),
		);
		expect(
			AuthStorage.create(authPath)
				.pendingNotices()
				.map((notice) => notice.provider),
		).toEqual(["openrouter"]);
	});
});
