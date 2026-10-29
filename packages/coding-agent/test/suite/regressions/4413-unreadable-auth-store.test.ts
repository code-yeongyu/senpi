import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRpcConnectionHandler } from "../../../src/modes/rpc/connection-handler.ts";
import { makeHarness, makeSink } from "../rpc-connection-harness.ts";

/**
 * senpi#4413: an auth.json that exists but cannot be loaded read as "nothing stored". Every stored
 * sign-in showed "Not connected" with no reason, and a top-level array loaded as an empty store
 * that the next login wrote over. The store must say it could not be read, refuse every write
 * until it can, and clear the error once the file is readable again.
 */
describe("an auth.json that cannot be loaded (senpi#4413)", () => {
	const STORED = { openrouter: { type: "api_key", key: "sk-stored-4413-not-a-key" } } as const;
	const VALID = JSON.stringify(STORED, null, 2);
	const cannotChmod = process.platform === "win32" || process.getuid?.() === 0;

	const cases = [
		{ name: "malformed JSON", kind: "malformed_json", content: VALID.slice(0, -1), mode: 0o600, skip: false },
		{ name: "a top-level null", kind: "invalid_format", content: "null", mode: 0o600, skip: false },
		{
			name: "a top-level array",
			kind: "invalid_format",
			content: JSON.stringify([STORED]),
			mode: 0o600,
			skip: false,
		},
		{ name: "a file it may not read", kind: "unreadable", content: VALID, mode: 0o000, skip: cannotChmod },
	] as const;

	let tempDir: string;
	let cleanup: () => void = () => {};

	beforeEach(() => {
		tempDir = join(tmpdir(), `senpi-4413-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		cleanup();
		cleanup = () => {};
		chmodSync(join(tempDir, "auth.json"), 0o600);
		rmSync(tempDir, { recursive: true, force: true });
	});

	type Row = { id: string; authType: string; status: { configured: boolean } };
	type ProvidersData = { providers: Row[]; storeError?: { kind: string; reason: string } };

	function open(content: string, mode: number) {
		const authPath = join(tempDir, "auth.json");
		writeFileSync(authPath, content, { mode: 0o600 });
		chmodSync(authPath, mode);
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		const collected = makeSink();
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);
		let next = 0;
		const send = async (command: Record<string, unknown>) => {
			const id = `request-${next++}`;
			await handler.handleInputLine(JSON.stringify({ id, ...command }));
			return collected.waitFor((message) => message.id === id);
		};
		const providers = async () => (await send({ type: "get_auth_providers" })).data as ProvidersData;
		return { authPath, handler, send, providers };
	}

	const storedRow = (data: ProvidersData) =>
		data.providers.find((row) => row.id === "openrouter" && row.authType === "api_key")?.status.configured;

	for (const scenario of cases) {
		it.skipIf(scenario.skip)(
			`${scenario.name}: reported as a typed load error, never as "not connected"`,
			async () => {
				const { handler, providers } = open(scenario.content, scenario.mode);

				const data = await providers();

				expect(data.storeError?.kind).toBe(scenario.kind);
				expect(typeof data.storeError?.reason).toBe("string");
				// Path-free and content-free: the reason names the problem, never the file or a key.
				expect(data.storeError?.reason).not.toContain(tempDir);
				expect(data.storeError?.reason).not.toContain("sk-stored");
				await handler.dispose();
			},
		);

		it.skipIf(scenario.skip)(`${scenario.name}: a login is refused and the file keeps its bytes`, async () => {
			const { authPath, handler, send } = open(scenario.content, scenario.mode);

			const saved = await send({ type: "login_api_key", provider: "openrouter", key: "sk-new-4413-not-a-key" });

			expect(saved.success).toBe(false);
			chmodSync(authPath, 0o600);
			expect(readFileSync(authPath, "utf-8")).toBe(scenario.content);
			await handler.dispose();
		});

		it.skipIf(scenario.skip)(`${scenario.name}: the error clears once the file is readable again`, async () => {
			const { authPath, handler, providers } = open(scenario.content, scenario.mode);
			expect((await providers()).storeError?.kind).toBe(scenario.kind);

			chmodSync(authPath, 0o600);
			writeFileSync(authPath, VALID);
			const data = await providers();

			expect(data.storeError).toBeUndefined();
			expect(storedRow(data)).toBe(true);
			await handler.dispose();
		});
	}
});
