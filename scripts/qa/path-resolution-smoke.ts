import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeFilesystemPath, composeFilesystemPolicies } from "../../packages/machine-ops/src/policy/filesystem.ts";
import { createLocalFileOps } from "../../packages/machine-ops/src/files/local-files.ts";
import { DEFAULT_LIMITS } from "../../packages/machine-ops/src/limits.ts";
import type { OpContext } from "../../packages/machine-ops/src/types.ts";

const root = await mkdtemp(join(await realpath(tmpdir()), "senpi-path-resolution-"));
try {
	const target = join(root, "target");
	const alias = join(root, "alias");
	await mkdir(target);
	await writeFile(join(target, "file.txt"), "fixture");
	await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
	assert.equal(await canonicalizeFilesystemPath(join(alias, "file.txt")), join(target, "file.txt"));
	assert.equal(await canonicalizeFilesystemPath(join(alias, "missing", "new.txt")), join(target, "missing", "new.txt"));
	assert.equal(await readFile(join(alias, "file.txt"), "utf8"), "fixture");
	const files = createLocalFileOps({});
	const ctx: OpContext = {
		scope: { id: "resolution-smoke", root: target },
		principal: { kind: "local-session", id: "resolution-smoke" },
		signal: new AbortController().signal,
		limits: DEFAULT_LIMITS,
		policy: {},
	};
	await files.write({ path: join(alias, "file.txt"), bytes: Buffer.from("updated") }, ctx);
	assert.equal(Buffer.from((await files.read({ path: join(alias, "file.txt") }, ctx)).bytes).toString(), "updated");
	const outside = join(root, "outside");
	await mkdir(outside);
	await writeFile(join(outside, "secret.txt"), "unchanged");
	await symlink(outside, join(target, "escape"), process.platform === "win32" ? "junction" : "dir");
	await assert.rejects(
		files.write({ path: join(target, "escape", "secret.txt"), bytes: Buffer.from("overwrite") }, ctx),
		{ code: "policy_denied" },
	);
	assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "unchanged");

	const controller = new AbortController();
	controller.abort();
	await assert.rejects(canonicalizeFilesystemPath(target, controller.signal), { name: "AbortError" });

	const checker = composeFilesystemPolicies([
		{ check: ({ canonicalPath }) => canonicalPath.startsWith(target) ? { allow: false, reason: "protected" } : { allow: true } },
	]);
	assert.ok(checker);
	assert.deepEqual(
		await checker({ operation: "read", canonicalPath: await canonicalizeFilesystemPath(join(alias, "file.txt")), toolName: "read" }),
		{ allow: false, reason: "protected" },
	);
	console.log(JSON.stringify({ passed: true, platform: process.platform, runtime: process.versions.bun ? "bun" : "node", version: process.version }));
} finally {
	await rm(root, { recursive: true, force: true });
}
