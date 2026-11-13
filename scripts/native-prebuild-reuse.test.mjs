import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadTargets } from "./native-prebuild-key.mjs";
import { recordFileName, writeRecord } from "./native-prebuild-record.mjs";

const repoRoot = join(import.meta.dirname, "..");
const cli = join(import.meta.dirname, "native-prebuild-reuse.mjs");
const workflow = readFileSync(join(repoRoot, ".github/workflows/native-prebuilds.yml"), "utf8");
const targets = loadTargets(repoRoot);
const rustc = "release: 1.91.0 commit-hash: f8297e351a40c1439a467bbbb6879088047f50b3";
const keys = Object.fromEntries(targets.map((target, index) => [target.artifact, `native-prebuild-v1-${target.artifact}-${String(index).repeat(64)}`]));

const roots = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch() {
	const root = mkdtempSync(join(tmpdir(), "native-prebuild-reuse-"));
	roots.push(root);
	return root;
}

function builtArtifact(dir, target, { key = keys[target.artifact], recordRustc = rustc } = {}) {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "manifest.txt"), `artifact=${target.artifact}\n`);
	writeFileSync(join(dir, `senpi_grep.${target.node_platform}-${target.node_arch}.node`), `grep ${target.artifact}\n`);
	writeRecord({ artifactDir: dir, target, key, rustc: recordRustc });
}

function run(args, env) {
	const outputFile = join(scratch(), "github-output");
	const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: outputFile, ...env } });
	assert.equal(result.status, 0, result.stderr);
	const outputs = Object.fromEntries(
		(existsSync(outputFile) ? readFileSync(outputFile, "utf8") : "")
			.trim()
			.split("\n")
			.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
	);
	return { outputs, stderr: result.stderr };
}

describe("native prebuild reuse steps", () => {
	it("select reuses verified cache entries and passes every other target, with its key, to the build matrix", () => {
		const cacheRoot = scratch();
		const [winX64, , , darwinArm64] = targets;
		builtArtifact(join(cacheRoot, darwinArm64.artifact), darwinArm64);
		builtArtifact(join(cacheRoot, winX64.artifact), winX64);
		writeFileSync(join(cacheRoot, winX64.artifact, "manifest.txt"), "tampered\n");

		const { outputs, stderr } = run(["select", "--cache-root", cacheRoot], { KEYS: JSON.stringify(keys), RUSTC: rustc });

		assert.deepEqual(JSON.parse(outputs.reused), [darwinArm64.artifact]);
		const matrix = JSON.parse(outputs.matrix);
		assert.deepEqual(
			matrix.include.map((row) => row.artifact),
			targets.map((target) => target.artifact).filter((artifact) => artifact !== darwinArm64.artifact),
		);
		for (const row of matrix.include) assert.equal(row.key, keys[row.artifact]);
		assert.deepEqual(JSON.parse(outputs.missing), matrix.include.map((row) => row.artifact));
		assert.equal(outputs.missing_count, "5");
		assert.match(stderr, /native-prebuild-win32-x64: BUILD \(sha256 mismatch: manifest\.txt\)/);
	});

	it("select builds nothing when every target verifies", () => {
		const cacheRoot = scratch();
		for (const target of targets) builtArtifact(join(cacheRoot, target.artifact), target);
		const { outputs } = run(["select", "--cache-root", cacheRoot], { KEYS: JSON.stringify(keys), RUSTC: rustc });
		assert.equal(outputs.missing_count, "0");
		assert.deepEqual(JSON.parse(outputs.matrix), { include: [] });
		assert.equal(JSON.parse(outputs.reused).length, 6);
	});

	it("record writes the builder's rustc and the planned key into the artifact", () => {
		const dir = scratch();
		const target = targets[3];
		writeFileSync(join(dir, "manifest.txt"), "x\n");
		run(["record", "--artifact-dir", dir], {
			TARGET_ARTIFACT: target.artifact,
			KEY: keys[target.artifact],
			RUSTC_VV: "rustc 1.91.0\ncommit-hash: f8297e351a40c1439a467bbbb6879088047f50b3\nhost: aarch64-apple-darwin\nrelease: 1.91.0\n",
		});
		const record = JSON.parse(readFileSync(join(dir, recordFileName(target)), "utf8"));
		assert.equal(record.key, keys[target.artifact]);
		assert.equal(record.rustc, rustc);
	});

	it("collect saves only built artifacts whose record matches the planned key and rustc", () => {
		const downloadRoot = scratch();
		const cacheRoot = scratch();
		const [winX64, winArm64, darwinX64] = targets;
		builtArtifact(join(downloadRoot, winX64.artifact), winX64);
		builtArtifact(join(downloadRoot, darwinX64.artifact), darwinX64, { recordRustc: rustc.replace("1.91.0", "1.92.0") });
		const missing = [winX64.artifact, winArm64.artifact, darwinX64.artifact];

		const { outputs, stderr } = run(["collect", "--download-root", downloadRoot, "--cache-root", cacheRoot], {
			KEYS: JSON.stringify(keys),
			RUSTC: rustc,
			MISSING: JSON.stringify(missing),
		});

		assert.deepEqual(JSON.parse(outputs.save), [winX64.artifact]);
		assert.deepEqual(readFileSync(join(cacheRoot, winX64.artifact, "manifest.txt")), readFileSync(join(downloadRoot, winX64.artifact, "manifest.txt")));
		assert.ok(!existsSync(join(cacheRoot, darwinX64.artifact)));
		assert.match(stderr, /native-prebuild-win32-arm64: SKIP \(not built in this run\)/);
		assert.match(stderr, /native-prebuild-darwin-x64: SKIP \(record rustc/);
	});
});

describe("native-prebuilds.yml reuse wiring", () => {
	const job = (name) => workflow.match(new RegExp(`\\n  ${name}:\\n[\\s\\S]*?(?=\\n  [a-z-]+:\\n|$)`))?.[0] ?? assert.fail(`job ${name} not found`);

	it("restores, re-uploads and saves every target at one cache path under its planned key", () => {
		const plan = job("plan");
		const save = job("save");
		for (const { artifact } of targets) {
			const path = `path: .native-prebuild-cache/${artifact}\n`;
			const restore = plan.match(new RegExp(`- name: Restore ${artifact}\\n[\\s\\S]*?(?=\\n\\n)`))?.[0];
			assert.ok(restore?.includes(path) && restore.includes(`key: \${{ fromJSON(steps.keys.outputs.keys)['${artifact}'] }}`), `${artifact}: restore step`);
			const upload = plan.match(new RegExp(`- name: Upload reused ${artifact}\\n[\\s\\S]*?(?=\\n\\n|$)`))?.[0];
			assert.ok(upload?.includes(path) && upload.includes(`name: ${artifact}\n`), `${artifact}: reused upload step`);
			assert.ok(upload.includes(`contains(fromJSON(steps.select.outputs.reused), '${artifact}')`), `${artifact}: upload gated on reuse`);
			const saveStep = save.match(new RegExp(`- name: Save ${artifact}\\n[\\s\\S]*?(?=\\n\\n|$)`))?.[0];
			assert.ok(saveStep?.includes(path) && saveStep.includes(`key: \${{ fromJSON(needs.plan.outputs.keys)['${artifact}'] }}`), `${artifact}: save step`);
			assert.ok(saveStep.includes(`contains(fromJSON(steps.collect.outputs.save), '${artifact}')`), `${artifact}: save gated on verification`);
		}
		assert.ok(!/restore-keys:/.test(workflow), "a prefix restore would hand back a prebuild of other inputs");
	});

	it("builds only the planned matrix and records the digest after the lifecycle checks, before the upload", () => {
		const build = job("build");
		assert.match(build, /needs: plan\n/);
		assert.match(build, /if: \$\{\{ needs\.plan\.outputs\.missing_count != '0' \}\}/);
		assert.match(build, /matrix: \$\{\{ fromJSON\(needs\.plan\.outputs\.matrix\) \}\}/);
		assert.doesNotMatch(build, /include:\n\s+- artifact:/, "build rows belong in scripts/native-prebuild-targets.json");
		const order = ["- name: Rust lifecycle tests", "- name: Node native load and lifecycle probe", "- name: Stage artifact", "- name: Record prebuild digest", "- name: Upload native prebuild"];
		const positions = order.map((step) => build.indexOf(step));
		assert.ok(positions.every((position, index) => position > 0 && (index === 0 || position > positions[index - 1])), `step order ${positions}`);
		assert.match(build, /KEY: \$\{\{ matrix\.key \}\}/);
	});

	it("reports ready only when plan succeeded and build ran exactly when targets were missing", () => {
		const ready = job("ready");
		assert.match(ready, /if: \$\{\{ always\(\) \}\}/);
		const script = ready.match(/run: \|\n([\s\S]*)/)?.[1].replace(/^ {10}/gm, "") ?? assert.fail("ready script");
		const readyFor = (plan, build, missing) => {
			const outputFile = join(scratch(), "github-output");
			const result = spawnSync("bash", ["-c", script], {
				encoding: "utf8",
				env: { PATH: process.env.PATH, GITHUB_OUTPUT: outputFile, PLAN_RESULT: plan, BUILD_RESULT: build, MISSING_COUNT: missing },
			});
			return result.status === 0 && readFileSync(outputFile, "utf8") === "ready=true\n";
		};
		assert.equal(readyFor("success", "skipped", "0"), true, "every target reused");
		assert.equal(readyFor("success", "success", "2"), true, "missing targets built");
		assert.equal(readyFor("success", "failure", "2"), false, "a required build failed");
		assert.equal(readyFor("success", "skipped", "2"), false, "missing targets never built");
		assert.equal(readyFor("success", "success", "0"), false, "build ran with nothing missing");
		assert.equal(readyFor("failure", "skipped", ""), false, "plan failed");
	});
});
