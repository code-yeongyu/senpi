import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../../../scripts/vitest-temp.ts";
import type { FilesystemPolicy } from "../../../src/core/extensions/types.ts";
import { composeFilesystemPolicies } from "../../../src/core/tools/filesystem-policy.ts";
import { createFindToolDefinition } from "../../../src/core/tools/find.ts";
import { createGrepToolDefinition } from "../../../src/core/tools/grep/index.ts";
import { createLsToolDefinition } from "../../../src/core/tools/ls.ts";

// omo#12466: a filesystem policy prunes walked entries (the memory guard leaves out every memory identity but the
// caller's). A pruned entry must leave no trace: each tool answers exactly what it answers on the same tree without
// that entry. Synthetic names only: "late-id" stands for an identity that appeared while a walk ran.
const FOREIGN = "synthetic-foreign-line";
const ALLOW = { allow: true } as const;

function memoryTree(withLateIdentity: boolean): string {
	const root = realpathSync(makeTempDir(join(tmpdir(), "omo-12466-walk-")));
	for (const file of ["a.md", "b.md", "c.md"]) {
		mkdirSync(join(root, "agents", "global", "repo"), { recursive: true });
		writeFileSync(join(root, "agents", "global", "repo", file), `synthetic own line in ${file}\n`);
	}
	if (withLateIdentity) {
		mkdirSync(join(root, "agents", "late-id", "repo"), { recursive: true });
		for (const file of ["a.md", "b.md", "c.md", "d.md"])
			writeFileSync(join(root, "agents", "late-id", "repo", file), `${FOREIGN} synthetic own line in ${file}\n`);
	}
	return root;
}

function pruning(root: string, excludesEntry: FilesystemPolicy["excludesEntry"]) {
	const policies: FilesystemPolicy[] = [{ check: () => ALLOW, ...(excludesEntry ? { excludesEntry } : {}) }];
	const policy = composeFilesystemPolicies(policies);
	if (!policy) throw new Error("no composed policy");
	return { root, policy };
}

const lateIdentity = (root: string) => (canonicalPath: string) =>
	canonicalPath === join(root, "agents", "late-id") || canonicalPath.startsWith(join(root, "agents", "late-id") + sep);

function comparable(value: unknown, root: string): unknown {
	const text = JSON.stringify(value)
		.replaceAll(root, "<root>")
		.replace(/elapsedMs=\d+/g, "elapsedMs=0");
	return JSON.parse(text, (key, field) => (key === "elapsedMs" ? 0 : field));
}

async function find(root: string, policy: ReturnType<typeof pruning>["policy"], limit: number) {
	const tool = createFindToolDefinition(root, { filesystemPolicy: policy });
	return tool.execute("find", { pattern: "**/*.md", path: root, limit }, undefined, undefined, undefined as never);
}

async function ls(root: string, policy: ReturnType<typeof pruning>["policy"], limit: number) {
	const tool = createLsToolDefinition(root, { filesystemPolicy: policy });
	return tool.execute("ls", { path: join(root, "agents"), limit }, undefined, undefined, undefined as never);
}

async function grep(root: string, policy: ReturnType<typeof pruning>["policy"], mode: "content" | "count" | "files") {
	const tool = createGrepToolDefinition(root, { filesystemPolicy: policy });
	return tool.execute("grep", { pattern: "synthetic", path: root, mode }, undefined, undefined, undefined as never);
}

describe("a policy that prunes walked entries (omo#12466)", () => {
	it("find answers as if the pruned identity did not exist, limit notice included", async () => {
		const late = memoryTree(true);
		const clean = memoryTree(false);

		for (const limit of [2, 3, 10]) {
			const pruned = await find(late, pruning(late, lateIdentity(late)).policy, limit);
			const reference = await find(clean, pruning(clean, undefined).policy, limit);

			expect(JSON.stringify(pruned)).not.toContain(FOREIGN);
			expect(JSON.stringify(pruned)).not.toContain("late-id");
			expect(comparable(pruned, late)).toEqual(comparable(reference, clean));
		}
	});

	it("ls answers as if the pruned identity did not exist, limit notice included", async () => {
		const late = memoryTree(true);
		const clean = memoryTree(false);

		for (const limit of [1, 10]) {
			const pruned = await ls(late, pruning(late, lateIdentity(late)).policy, limit);
			const reference = await ls(clean, pruning(clean, undefined).policy, limit);

			expect(JSON.stringify(pruned)).not.toContain("late-id");
			expect(comparable(pruned, late)).toEqual(comparable(reference, clean));
		}
	});

	it("grep answers as if the pruned identity did not exist, counts and scan statistics included", async () => {
		const late = memoryTree(true);
		const clean = memoryTree(false);

		for (const mode of ["content", "count", "files"] as const) {
			const pruned = await grep(late, pruning(late, lateIdentity(late)).policy, mode);
			const reference = await grep(clean, pruning(clean, () => false).policy, mode);

			expect(JSON.stringify(pruned)).not.toContain(FOREIGN);
			expect(JSON.stringify(pruned)).not.toContain("late-id");
			expect(comparable(pruned, late)).toEqual(comparable(reference, clean));
		}
	});

	it("excludes an entry when a policy's filter throws, and when any one policy excludes it", async () => {
		const late = memoryTree(true);
		const clean = memoryTree(false);
		const throwing = composeFilesystemPolicies([
			{ check: () => ALLOW, excludesEntry: () => false },
			{
				check: () => ALLOW,
				excludesEntry: (canonicalPath) => {
					if (lateIdentity(late)(canonicalPath)) throw new Error("synthetic filter failure");
					return false;
				},
			},
		]);
		if (!throwing) throw new Error("no composed policy");

		const pruned = await grep(late, throwing, "content");
		const reference = await grep(clean, pruning(clean, () => false).policy, "content");

		expect(JSON.stringify(pruned)).not.toContain(FOREIGN);
		expect(comparable(pruned, late)).toEqual(comparable(reference, clean));
	});
});
