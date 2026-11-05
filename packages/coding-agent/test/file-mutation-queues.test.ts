// senpi#5691 review HIGH: an operation that holds several files' mutation slots (a rename, a multi-file patch) must
// never wait on a slot it already holds, and two such operations over the same files must never wait on each other.
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireFileMutationLock, withFileMutationQueues } from "../src/core/tools/file-mutation-queue.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function twoFiles(): Promise<{ readonly a: string; readonly b: string; readonly dir: string }> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-queues-"));
	dirs.push(dir);
	const a = join(dir, "a.md");
	const b = join(dir, "b.md");
	await writeFile(a, "a");
	await writeFile(b, "b");
	return { a, b, dir };
}

describe("holding several files' mutation slots (senpi#5691)", () => {
	it("takes one slot for two spellings of one file", async () => {
		const { a, dir } = await twoFiles();
		const alias = join(dir, "alias.md");
		await symlink(a, alias);

		const ran = await withFileMutationQueues([a, alias], async () => "ran");

		expect(ran).toBe("ran");
	});

	it("takes the slots of swapped file orders in one order, so neither waits on the other", async () => {
		const { a, b } = await twoFiles();
		const release = await acquireFileMutationLock(b);
		const order: string[] = [];

		const backward = withFileMutationQueues([b, a], async () => {
			order.push("b,a");
		});
		const forward = withFileMutationQueues([a, b], async () => {
			order.push("a,b");
		});
		release();
		await Promise.all([backward, forward]);

		expect(order.sort()).toEqual(["a,b", "b,a"]);
	});
});
