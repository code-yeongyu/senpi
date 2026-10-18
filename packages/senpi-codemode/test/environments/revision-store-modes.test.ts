import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishNextRevision } from "../../src/environments/revision-store.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// The Python and JavaScript environments publish through this one store, so these cases cover both.
describe("Given the revision store under a permissive umask", () => {
	it.each([["py"], ["js"]])(
		"When a %s environment publishes its first two revisions under umask 022, then every directory it created is private to the user",
		async (language) => {
			const root = await mkdtemp(join(tmpdir(), "senpi-store-modes-"));
			roots.push(root);
			const base = join(root, "artifacts", "environments", language, "runtime");
			const previous = process.umask(0o022);
			try {
				const first = await publishNextRevision(base, async (staging) => {
					await writeFile(join(staging, "installed"), "one\n");
				});
				const second = await publishNextRevision(base, async (staging) => {
					await writeFile(join(staging, "installed"), "two\n");
				});
				const created = [
					join(root, "artifacts"),
					join(root, "artifacts", "environments"),
					join(root, "artifacts", "environments", language),
					base,
					first.revision.dir,
					second.revision.dir,
				];
				const modes = await Promise.all(
					created.map(async (dir) => [relative(root, dir), ((await stat(dir)).mode & 0o777).toString(8)]),
				);

				expect(modes).toEqual(created.map((dir) => [relative(root, dir), "700"]));
			} finally {
				process.umask(previous);
			}
		},
	);

	it("When a revision created 0755 before this change is the active one, then the next revision is still private to the user", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-store-modes-"));
		roots.push(root);
		const base = join(root, "artifacts", "environments", "js", "runtime");
		const previous = process.umask(0o022);
		try {
			const first = await publishNextRevision(base, async (staging) => {
				await writeFile(join(staging, "installed"), "one\n");
			});
			await chmod(first.revision.dir, 0o755);
			const second = await publishNextRevision(base, async (staging) => {
				await writeFile(join(staging, "installed"), "two\n");
			});

			expect(((await stat(second.revision.dir)).mode & 0o777).toString(8)).toBe("700");
		} finally {
			process.umask(previous);
		}
	});
});
