import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	it("keys prints one key per target for the normalized rustc of this checkout", () => {
		const vv = "rustc 1.91.0\ncommit-hash: f8297e351a40c1439a467bbbb6879088047f50b3\nhost: x86_64-unknown-linux-gnu\nrelease: 1.91.0\n";
		const { outputs } = run(["keys"], { RUSTC_VV: vv });
		assert.equal(outputs.rustc, rustc);
		const printed = JSON.parse(outputs.keys);
		assert.deepEqual(Object.keys(printed), targets.map((target) => target.artifact));
		for (const [artifact, key] of Object.entries(printed)) assert.match(key, new RegExp(`^native-prebuild-v1-${artifact}-[0-9a-f]{64}$`));
		assert.equal(new Set(Object.values(printed)).size, targets.length, "two targets share a key");
		assert.equal(run(["keys"], { RUSTC_VV: vv.replace("host: x86_64-unknown-linux-gnu", "host: aarch64-apple-darwin") }).outputs.keys, outputs.keys, "the runner host changed the keys");
		const newerRelease = JSON.parse(run(["keys"], { RUSTC_VV: vv.replaceAll("1.91.0", "1.91.1") }).outputs.keys);
		const newerCommit = JSON.parse(run(["keys"], { RUSTC_VV: vv.replace("f8297e351a40c1439a467bbbb6879088047f50b3", "0".repeat(40)) }).outputs.keys);
		for (const target of targets) {
			assert.notEqual(newerRelease[target.artifact], printed[target.artifact], `${target.artifact}: a new rustc release kept the key`);
			assert.notEqual(newerCommit[target.artifact], printed[target.artifact], `${target.artifact}: a new rustc commit kept the key`);
		}
	});

	it("select reuses verified cache entries and passes every other target, with its key, to the build matrix", () => {
		const cacheRoot = scratch();
		const [winX64, , , darwinArm64] = targets;
		builtArtifact(join(cacheRoot, darwinArm64.artifact), darwinArm64);
		builtArtifact(join(cacheRoot, winX64.artifact), winX64);
		writeFileSync(join(cacheRoot, winX64.artifact, "manifest.txt"), "tampered\n");

		const { outputs, stderr } = run(["select", "--cache-root", cacheRoot], { KEYS: JSON.stringify(keys), MATCHED_KEYS: JSON.stringify(keys), RUSTC: rustc });

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
		const { outputs } = run(["select", "--cache-root", cacheRoot], { KEYS: JSON.stringify(keys), MATCHED_KEYS: JSON.stringify(keys), RUSTC: rustc });
		assert.equal(outputs.missing_count, "0");
		assert.deepEqual(JSON.parse(outputs.matrix), { include: [] });
		assert.equal(JSON.parse(outputs.reused).length, 6);
	});

	it("select rebuilds a target whose restored entry was matched by prefix rather than by the exact key", () => {
		const cacheRoot = scratch();
		const target = targets[3];
		builtArtifact(join(cacheRoot, target.artifact), target);
		const matched = { ...keys, [target.artifact]: `${keys[target.artifact]}-longer` };
		const { outputs, stderr } = run(["select", "--cache-root", cacheRoot], { KEYS: JSON.stringify(keys), MATCHED_KEYS: JSON.stringify(matched), RUSTC: rustc });
		assert.deepEqual(JSON.parse(outputs.reused), []);
		assert.equal(outputs.missing_count, "6");
		assert.match(stderr, /native-prebuild-darwin-arm64: BUILD \(restored entry .*-longer is not the exact key\)/);
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
			const id = `restore_${artifact.replace("native-prebuild-", "").replace("-", "_")}`;
			assert.ok(restore?.includes(`id: ${id}\n`), `${artifact}: restore step id`);
			assert.ok(plan.includes(`"${artifact}": "\${{ steps.${id}.outputs.cache-matched-key }}"`), `${artifact}: matched key passed to select`);
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

// The Actions cache is scoped per ref, not per workflow: any job running with the default branch's ref can
// write an entry a release on main restores. Workflows that react to outside input (issues, comments,
// pull_request_target, workflow_run) run in that scope, so none of them may execute code from an
// untrusted ref or give an agent a shell (senpi#6622 threat model, point 1).
describe("default-branch cache scope writers", () => {
	const workflowsDir = join(repoRoot, ".github/workflows");
	const outsideTriggers = /^  (issues|issue_comment|pull_request_target|workflow_run|discussion|discussion_comment|pull_request_review|pull_request_review_comment):/m;
	const files = readdirSync(workflowsDir).filter((file) => file.endsWith(".yml"));

	it("finds the workflows that run in the default-branch scope on outside input", () => {
		const outside = files.filter((file) => outsideTriggers.test(readFileSync(join(workflowsDir, file), "utf8"))).sort();
		assert.deepEqual(outside, ["issue-analysis.yml", "issue-triage-labels.yml", "publish-model-catalog.yml", "remove-inprogress-on-close.yml", "review-claims.yml"], "a new outside-input workflow needs a review against the native prebuild cache before it joins this list");
	});

	it("never checks out a pull request head, and gates workflow_run to this repository's own pushes to main", () => {
		for (const file of files) {
			const text = readFileSync(join(workflowsDir, file), "utf8");
			if (!outsideTriggers.test(text)) continue;
			assert.doesNotMatch(text, /github\.event\.pull_request\.head\.(sha|ref)|refs\/pull\//, `${file} checks out a pull request ref in the default-branch scope`);
			assert.doesNotMatch(text, /actions\/cache\/save|actions\/cache@|Swatinem\/rust-cache/, `${file} writes cache entries directly`);
			if (/^  workflow_run:/m.test(text)) {
				for (const [, condition] of text.matchAll(/^    if: \$\{\{ (github\.event_name != 'workflow_run' \|\|[^\n]*|[^\n]*workflow_run[^\n]*) \}\}$/gm)) {
					assert.match(condition, /head_repository\.full_name == github\.repository/, `${file}: workflow_run job not limited to this repository`);
					assert.match(condition, /workflow_run\.event == 'push'/, `${file}: workflow_run job not limited to pushes`);
				}
			}
		}
	});

	it("runs the issue analysis agent without a shell", () => {
		const text = readFileSync(join(workflowsDir, "issue-analysis.yml"), "utf8");
		assert.match(text, /--tools read,grep,find,ls\b/);
		assert.match(text, /--permission "bash=deny,edit=deny,external_directory=deny"/);
	});
});
