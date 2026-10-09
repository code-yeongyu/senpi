import { mkdirSync } from "node:fs";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { withFileMutationQueue } from "../../src/harness/tools/file-mutation-queue.ts";
import { createTempDir } from "./session-test-utils.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("withFileMutationQueue", () => {
	it.each([
		["a new file", "new.txt"],
		["a new file in a new subdirectory", join("sub", "new.txt")],
	])("serializes %s reached through a symlinked directory and through its real directory", async (_label, name) => {
		const root = createTempDir();
		mkdirSync(join(root, "real"));
		await symlink(join(root, "real"), join(root, "link"));
		const env = new NodeExecutionEnv({ cwd: root });
		const events: string[] = [];
		const aStarted = deferred();
		const aHold = deferred();

		const a = withFileMutationQueue(
			env,
			join("link", name),
			async () => {
				events.push("A start");
				aStarted.resolve();
				await aHold.promise;
				events.push("A end");
			},
			BACKGROUND_CONTEXT,
		);
		await aStarted.promise;

		const b = withFileMutationQueue(
			env,
			join(root, "real", name),
			async () => {
				events.push("B start");
			},
			BACKGROUND_CONTEXT,
		);
		// The queue resolves keys in call order, so once a mutation of an unrelated file queued after B has run,
		// B's key is registered and B would already have started if it did not share A's key.
		await withFileMutationQueue(env, "unrelated.txt", async () => {}, BACKGROUND_CONTEXT);

		expect(events).toEqual(["A start"]);
		aHold.resolve();
		await Promise.all([a, b]);
		expect(events).toEqual(["A start", "A end", "B start"]);
	});
});
