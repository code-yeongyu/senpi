// The release bundle emits the Cursor provider as a self-contained chunk that carries its own copy
// of every module it imports, while the agent loop and the coding agent use the main graph's copy
// (#2334). Each case loads two copies of a module the way the bundle does and checks that what one
// copy writes, the other reads.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function twoCopies<T extends object>(load: () => Promise<T>): Promise<readonly [T, T]> {
	vi.resetModules();
	const first = await load();
	vi.resetModules();
	const second = await load();
	expect(second).not.toBe(first);
	return [first, second];
}

describe("state shared by bundle copies of a module", () => {
	let storeDir: string;
	const previousStoreEnv = process.env.CURSOR_CONTEXT_LIMIT_STORE;

	beforeEach(() => {
		storeDir = mkdtempSync(join(tmpdir(), "bundle-module-copies-"));
		process.env.CURSOR_CONTEXT_LIMIT_STORE = join(storeDir, "cursor-context-limits.json");
	});

	afterEach(async () => {
		const limits = await import("../src/utils/cursor-context-limit.ts");
		limits.resetCursorContextLimitStoreForTest();
		if (previousStoreEnv === undefined) delete process.env.CURSOR_CONTEXT_LIMIT_STORE;
		else process.env.CURSOR_CONTEXT_LIMIT_STORE = previousStoreEnv;
		rmSync(storeDir, { recursive: true, force: true });
	});

	it("recognizes a block one copy marked as already executed by Cursor's exec channel", async () => {
		// Given
		const [provider, loop] = await twoCopies(() => import("../src/utils/block-symbols.ts"));
		const block: Record<PropertyKey, unknown> = { type: "toolCall", id: "call-1" };

		// When
		block[provider.kCursorExecResolved] = true;

		// Then
		expect(loop.isCursorExecResolved(block)).toBe(true);
		expect(loop.kStreamingPartialJson).toBe(provider.kStreamingPartialJson);
		expect(loop.kStreamingBlockIndex).toBe(provider.kStreamingBlockIndex);
		expect(loop.kStreamingLastParseLen).toBe(provider.kStreamingLastParseLen);
		expect(loop.kStreamingEnvelopeId).toBe(provider.kStreamingEnvelopeId);
		expect(loop.kStreamingBlockKind).toBe(provider.kStreamingBlockKind);
	});

	it("runs a cleanup registered through one copy when another copy disposes the session", async () => {
		// Given
		const [provider, session] = await twoCopies(() => import("../src/session-resources.ts"));
		const released: Array<string | undefined> = [];
		const unregister = provider.registerSessionResourceCleanup((sessionId) => released.push(sessionId));

		try {
			// When
			session.cleanupSessionResources("session-1");

			// Then
			expect(released).toEqual(["session-1"]);
		} finally {
			unregister();
		}
	});

	it("serves a context ceiling one copy recorded to a copy that already read the store", async () => {
		// Given: the reading copy hydrated before the ceiling was observed.
		const [provider, session] = await twoCopies(() => import("../src/utils/cursor-context-limit.ts"));
		expect(session.getCursorContextLimit("kimi-k3")).toBeUndefined();

		// When
		provider.recordCursorContextLimit("kimi-k3", 200_000);

		// Then
		expect(session.getCursorContextLimit("kimi-k3")).toBe(200_000);
	});
});
