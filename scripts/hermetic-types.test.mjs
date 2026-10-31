#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const baseConfigPath = join(repoRoot, "tsconfig.base.json");
const tsc = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "senpi-hermetic-types-")));

after(() => rmSync(scratch, { recursive: true, force: true }));

const toPosix = (path) => path.replaceAll("\\", "/");

/**
 * Lists the files tsc loads for a project that extends the real tsconfig.base.json, placed under a
 * decoy parent folder whose node_modules/@types/node lacks ForkOptions.windowsHide, like the stray
 * ~/node_modules copy behind senpi#3482.
 */
function listUnderDecoyParent() {
	const decoy = join(scratch, "decoy");
	const project = join(decoy, "project");
	const decoyTypes = join(decoy, "node_modules", "@types", "node");
	mkdirSync(decoyTypes, { recursive: true });
	writeFileSync(join(decoyTypes, "package.json"), JSON.stringify({ name: "@types/node", version: "0.0.0-decoy", types: "index.d.ts" }));
	writeFileSync(join(decoyTypes, "index.d.ts"), 'declare module "child_process" { interface ForkOptions { cwd?: string } }\n');
	mkdirSync(project, { recursive: true });
	writeFileSync(join(project, "probe.ts"), "export const probe = 1;\n");
	writeFileSync(
		join(project, "tsconfig.json"),
		JSON.stringify({ extends: toPosix(baseConfigPath), compilerOptions: { noEmit: true }, include: ["probe.ts"] }),
	);
	const run = spawnSync(process.execPath, [tsc, "-p", join(project, "tsconfig.json"), "--listFilesOnly"], { encoding: "utf8" });
	const files = run.stdout.split(/\r?\n/).filter((line) => isAbsolute(line)).map(toPosix);
	return { decoy: toPosix(join(decoy, "node_modules")), status: run.status, stderr: run.stderr, files };
}

test("a project extending tsconfig.base.json under a decoy @types/node loads node types only from the repository (senpi#3482)", () => {
	const { decoy, status, stderr, files } = listUnderDecoyParent();
	const nodeTypes = files.filter((file) => file.includes("/@types/node/"));

	assert.deepEqual({ status, stderr }, { status: 0, stderr: "" });
	assert.ok(nodeTypes.length > 0, "tsc loaded no @types/node file at all");
	assert.deepEqual(nodeTypes.filter((file) => file.startsWith(decoy)), []);
	assert.deepEqual(nodeTypes.filter((file) => !file.startsWith(toPosix(realpathSync(repoRoot)))), []);
});

test("tsconfig.base.json pins every type root inside the repository's own node_modules", () => {
	const { compilerOptions } = JSON.parse(readFileSync(baseConfigPath, "utf8"));
	const nodeModules = resolve(repoRoot, "node_modules");

	assert.ok(Array.isArray(compilerOptions.typeRoots) && compilerOptions.typeRoots.length > 0);
	for (const root of compilerOptions.typeRoots) {
		const target = resolve(repoRoot, root);
		assert.ok(target === nodeModules || target.startsWith(`${nodeModules}${sep}`), `${root} resolves outside node_modules`);
	}
});
