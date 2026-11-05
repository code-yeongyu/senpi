import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { JsonlSessionRepo } from "../../src/harness/session/jsonl/index.ts";
import { getOrThrow } from "../../src/harness/types.ts";
import { createTempDir } from "./session-test-utils.ts";

/**
 * Lets a test remove a directory entry after `readdir` has listed it and before `listDir` stats it,
 * the window in which another process releases a lock directory or renames a staged file.
 */
const lstatHook = vi.hoisted(() => ({ before: undefined as ((path: string) => Promise<void>) | undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		lstat: async (...args: Parameters<typeof actual.lstat>) => {
			await lstatHook.before?.(String(args[0]));
			return actual.lstat(...args);
		},
	};
});

/** Removes `target` (with the real fs) the first time `listDir` is about to stat it. */
function removeBeforeFirstStat(target: string): { readonly removed: () => boolean } {
	let removed = false;
	lstatHook.before = async (path) => {
		if (removed || path !== target) return;
		removed = true;
		await rm(target, { recursive: true, force: true });
	};
	return { removed: () => removed };
}

afterEach(() => {
	lstatHook.before = undefined;
});

describe("NodeExecutionEnv.listDir with entries removed while it lists", () => {
	it("omits an entry that disappears between readdir and lstat", async () => {
		const root = createTempDir();
		await writeFile(join(root, "kept.txt"), "kept");
		await writeFile(join(root, "gone.txt"), "gone");
		const env = new NodeExecutionEnv({ cwd: root });
		const hook = removeBeforeFirstStat(join(root, "gone.txt"));

		const entries = getOrThrow(await env.listDir(".", BACKGROUND_CONTEXT));

		expect(hook.removed()).toBe(true);
		expect(entries.map((entry) => entry.name)).toEqual(["kept.txt"]);
	});

	it("lists sessions while another owner releases a session lock directory", async () => {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		const repo = new JsonlSessionRepo({ fileSystem, sessionsRoot: "sessions", now: () => 1_700_000_000_000 });
		const session = await repo.create({ id: "demo-1", cwd: "/workspace" }, BACKGROUND_CONTEXT);
		const metadata = session.metadata;
		await session.close(BACKGROUND_CONTEXT);
		// proper-lockfile holds a session as the directory `<session>.jsonl.lock` and removes it on release.
		const lockDirectory = `${metadata.path}.lock`;
		await mkdir(lockDirectory);
		const hook = removeBeforeFirstStat(lockDirectory);

		const listed = await repo.list(undefined, BACKGROUND_CONTEXT);

		expect(hook.removed()).toBe(true);
		expect(listed.map((entry) => entry.id)).toEqual(["demo-1"]);
	});
});
