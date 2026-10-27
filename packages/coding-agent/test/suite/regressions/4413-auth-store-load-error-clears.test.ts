import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthStorage, type AuthStorageBackend } from "../../../src/core/auth-storage.ts";

/**
 * senpi#4413 review: an AuthStorage instance that saw a broken auth.json must drop its load error on
 * EVERY path that later reads or writes the good file, through the same instance or after another
 * instance repaired it. A failure after the document was read and parsed is not an unreadable file.
 */
describe("an auth.json load error clears on every path that reads or writes the good file (senpi#4413)", () => {
	const STORED = { openrouter: { type: "api_key", key: "sk-stored-4413-not-a-key" } };
	const ORIGINAL = JSON.stringify(STORED, null, 2);
	const OTHER_GOOD = JSON.stringify({ ...STORED, groq: { type: "api_key", key: "sk-other-4413-not-a-key" } }, null, 2);
	const GROQ = { type: "api_key", key: "sk-groq-4413-not-a-key" } as const;

	let dir: string;
	let authPath: string;

	// One path for every row, so instances share the process-wide read state the way they do in a session.
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "senpi-4413-clears-"));
		authPath = join(dir, "auth.json");
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	type Instances = { broken: AuthStorage; other: AuthStorage };
	type Row = {
		path: string;
		repair: (instances: Instances) => unknown;
		act: (instances: Instances) => unknown;
	};

	const originalBytes = () => writeFileSync(authPath, ORIGINAL);
	const otherGoodBytes = () => writeFileSync(authPath, OTHER_GOOD);
	const nothing = () => undefined;

	const rows: Row[] = [
		{ path: "sync reload, original bytes back", repair: originalBytes, act: ({ broken }) => broken.reload() },
		{ path: "sync reload, other good bytes", repair: otherGoodBytes, act: ({ broken }) => broken.reload() },
		{
			path: "async read, original bytes back",
			repair: originalBytes,
			act: ({ broken }) => broken.read("openrouter"),
		},
		{ path: "async read, other good bytes", repair: otherGoodBytes, act: ({ broken }) => broken.read("openrouter") },
		{ path: "async list, original bytes back", repair: originalBytes, act: ({ broken }) => broken.list() },
		{
			path: "async readSlot, original bytes back",
			repair: originalBytes,
			act: ({ broken }) => broken.readSlot("openrouter", "default"),
		},
		{
			path: "async read after another instance's sync set",
			repair: ({ other }) => {
				originalBytes();
				other.set("groq", GROQ);
			},
			act: ({ broken }) => broken.read("openrouter"),
		},
		{
			path: "async read after another instance's async modify",
			repair: async ({ other }) => {
				originalBytes();
				await other.modify("groq", async () => GROQ);
			},
			act: ({ broken }) => broken.read("openrouter"),
		},
		{
			path: "sync reload after another instance's async delete",
			repair: async ({ other }) => {
				originalBytes();
				await other.delete("groq");
			},
			act: ({ broken }) => broken.reload(),
		},
		{ path: "sync set by the same instance", repair: originalBytes, act: ({ broken }) => broken.set("groq", GROQ) },
		{ path: "sync remove by the same instance", repair: originalBytes, act: ({ broken }) => broken.remove("groq") },
		{
			path: "sync setSlot by the same instance",
			repair: originalBytes,
			act: ({ broken }) =>
				broken.setSlot("groq", { name: "default", key: "sk-slot-4413-not-a-key", source: "login" }),
		},
		{
			path: "sync removeSlot by the same instance",
			repair: originalBytes,
			act: ({ broken }) => broken.removeSlot("groq", "default"),
		},
		{
			path: "async modify (write) by the same instance",
			repair: originalBytes,
			act: ({ broken }) => broken.modify("groq", async () => GROQ),
		},
		{
			path: "async modify (no write) by the same instance",
			repair: originalBytes,
			act: ({ broken }) => broken.modify("groq", async () => undefined),
		},
		{ path: "async delete by the same instance", repair: originalBytes, act: ({ broken }) => broken.delete("groq") },
		{ path: "nothing repaired: the error stays", repair: nothing, act: ({ broken }) => broken.read("openrouter") },
	];

	for (const row of rows) {
		it(row.path, async () => {
			originalBytes();
			const other = AuthStorage.create(authPath);
			writeFileSync(authPath, JSON.stringify([STORED]));
			const broken = AuthStorage.create(authPath);
			expect(broken.getLoadError()?.kind).toBe("invalid_format");

			await row.repair({ broken, other });
			await row.act({ broken, other });

			if (row.repair === nothing) {
				expect(broken.getLoadError()?.kind).toBe("invalid_format");
				return;
			}
			expect(broken.getLoadError()).toBeUndefined();
			expect(broken.get("openrouter")).toEqual(STORED.openrouter);
		});
	}

	type Stage = "before read" | "write back" | "lock lost after read";
	const LEGACY = JSON.stringify({ "openai-codex": { type: "api_key", key: "sk-legacy-4413-not-a-key" } }, null, 2);
	const failure = (code: string) => Object.assign(new Error(`simulated ${code}`), { code });

	/** A backend that fails at one stage, in the sync or the async lock only; the other one works without saving. */
	function failingBackend(content: string, mode: "sync" | "async", stage: Stage, error: Error): AuthStorageBackend {
		return {
			withLock(fn) {
				if (mode === "sync" && stage === "before read") throw error;
				const { result, next } = fn(content);
				if (mode === "sync" && stage === "write back" && next !== undefined) throw error;
				return result;
			},
			async withLockAsync(fn) {
				if (mode === "async" && stage === "before read") throw error;
				const { result, next } = await fn(content);
				if (mode === "async" && stage === "write back" && next !== undefined) throw error;
				if (mode === "async" && stage === "lock lost after read") throw error;
				return result;
			},
		};
	}

	const classified: Array<{
		name: string;
		content: string;
		mode: "sync" | "async";
		stage: Stage;
		error: Error;
		kind: string | undefined;
	}> = [
		{
			name: "sync: the file cannot be opened",
			content: ORIGINAL,
			mode: "sync",
			stage: "before read",
			error: failure("EACCES"),
			kind: "unreadable",
		},
		{
			name: "sync: the migrated copy cannot be saved",
			content: LEGACY,
			mode: "sync",
			stage: "write back",
			error: failure("EROFS"),
			kind: "write_back_failed",
		},
		{
			name: "async: the file cannot be opened",
			content: ORIGINAL,
			mode: "async",
			stage: "before read",
			error: failure("EACCES"),
			kind: "unreadable",
		},
		{
			name: "async: the migrated copy cannot be saved",
			content: LEGACY,
			mode: "async",
			stage: "write back",
			error: failure("EROFS"),
			kind: "write_back_failed",
		},
		{
			name: "async: the lock is lost after a clean read",
			content: ORIGINAL,
			mode: "async",
			stage: "lock lost after read",
			error: new Error("simulated lock compromised"),
			kind: undefined,
		},
	];

	for (const scenario of classified) {
		it(`classifies a failed load: ${scenario.name}`, async () => {
			const storage = AuthStorage.fromStorage(
				failingBackend(scenario.content, scenario.mode, scenario.stage, scenario.error),
			);
			if (scenario.mode === "async") await storage.list();

			expect(storage.getLoadError()?.kind).toBe(scenario.kind);
			expect(storage.drainErrors().length).toBeGreaterThan(0);
		});
	}
});
