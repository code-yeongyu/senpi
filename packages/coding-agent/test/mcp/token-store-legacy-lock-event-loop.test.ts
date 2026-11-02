import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashServerUrl, McpTokenStore } from "../../src/core/extensions/builtin/mcp/auth/token-store.ts";

// senpi#3546: the synchronous token lookup every MCP HTTP request makes spun on the legacy-migration lock with
// the event loop blocked. When the holder was an asynchronous reader in the same process it could never run its
// release, so the whole process froze until the lock went stale (30 s), and tool calls failed with
// "MCP metadata was not ready before the request timeout".
const SERVER_URL = "http://127.0.0.1:1/mcp";
const STALE_MS = 1_500;

let agentDir = "";
afterEach(() => {
	if (agentDir) rmSync(agentDir, { force: true, recursive: true });
	agentDir = "";
});

function setup(): { store: McpTokenStore; lockPath: string; legacyTokens: string } {
	agentDir = mkdtempSync(join(tmpdir(), "mcp-legacy-lock-loop-"));
	const root = join(agentDir, "mcp-auth");
	mkdirSync(root, { mode: 0o700, recursive: true });
	const store = new McpTokenStore({
		serverName: "fx",
		serverUrl: SERVER_URL,
		agentDir,
		lock: { retries: 50, stale: STALE_MS },
	});
	return {
		store,
		lockPath: join(root, `${hashServerUrl(SERVER_URL)}.migrate.lock`),
		legacyTokens: join(root, hashServerUrl(SERVER_URL), "tokens.json"),
	};
}

function writeLegacy(path: string): void {
	mkdirSync(join(path, ".."), { mode: 0o700, recursive: true });
	writeFileSync(path, `${JSON.stringify({ accessToken: "legacy-at", refreshToken: "legacy-rt" })}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
}

describe("MCP token store legacy-migration lock and the event loop", () => {
	it("reads a server with no saved grant without touching another holder's migration lock", async () => {
		// Given: no saved grant and no legacy grant, while someone else holds the migration lock.
		const { store, lockPath } = setup();
		writeFileSync(lockPath, "", { mode: 0o600 });

		// When: the per-request synchronous lookup and the background lookup run.
		const syncRead = store.read();
		const asyncRead = await store.readAsync();

		// Then: both answer "no grant" without waiting on, stealing, or failing on the held lock.
		expect(syncRead).toBeUndefined();
		expect(asyncRead).toBeUndefined();
		expect(existsSync(lockPath)).toBe(true);
	});

	it("claims a legacy grant before the background lookup first yields, so it never holds the lock across a turn", async () => {
		// Given: a legacy URL-keyed grant waiting to be claimed.
		const { store, lockPath, legacyTokens } = setup();
		writeLegacy(legacyTokens);

		// When: the background lookup starts; nothing has run on the event loop yet.
		const pending = store.readAsync();

		// Then: the claim and the lock release already happened, so a synchronous lookup now cannot spin on it.
		expect(existsSync(legacyTokens)).toBe(false);
		expect(existsSync(lockPath)).toBe(false);
		expect(store.read()?.refreshToken).toBe("legacy-rt");
		await expect(pending).resolves.toMatchObject({ refreshToken: "legacy-rt" });
	});
});
