#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as suite from "./release-forced-test-suite.mjs";
import { resolveWorkspaceDirectories } from "./run-workspaces.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const HANG = "setInterval(() => {}, 1000)";
const step = (label, source) => ({ label, cwd: process.cwd(), bin: process.execPath, args: ["-e", source] });
const touch = (file) => `require("node:fs").writeFileSync(${JSON.stringify(file)}, "")`;
const shard = (index, total, source) => step(`packages/coding-agent shard ${index}/${total}`, source);

/** The rejection of one forced-suite run (null when it passed); a synchronous throw counts as a rejection. */
async function failureOf(options) {
	return Promise.resolve()
		.then(() => suite.runForcedTestSuite({ log: () => {}, ...options }))
		.then(
			() => null,
			(error) => error,
		);
}

function withDir(run) {
	const dir = mkdtempSync(join(tmpdir(), "forced-suite-"));
	return Promise.resolve()
		.then(() => run(dir))
		.finally(() => rmSync(dir, { recursive: true, force: true }));
}

const workspace = (relativePath, scripts) => ({ relativePath, directory: `/r/${relativePath}`, name: relativePath, scripts });
const workspaceOf = (planned) => planned.args[planned.args.indexOf("--workspace") + 1];

describe("planForcedTestSuite (senpi#6139)", () => {
	it("runs every tested workspace once: the others serially, coding-agent as shards 1/N..N/N", () => {
		const workspaces = [
			workspace("packages/ai", { test: "vitest --run" }),
			workspace("packages/coding-agent", { test: "node ../../scripts/run-tests.mjs vitest --run" }),
			workspace("packages/coding-agent/examples/extensions/sandbox", {}),
			workspace("packages/tui", { test: "node --test" }),
		];
		const plan = suite.planForcedTestSuite({ rootDirectory: "/r", workspaces, shards: 3 });
		assert.deepEqual(
			plan.serial.map((planned) => planned.label),
			["scripts", "packages/ai", "packages/tui"],
		);
		assert.deepEqual(plan.serial[0].args, ["run", "test:scripts"]);
		for (const planned of plan.serial.slice(1)) {
			assert.equal(planned.args.at(-1), "test", `${planned.label} runs its own test script, unsharded`);
			assert.equal(workspaceOf(planned), planned.label);
		}
		assert.deepEqual(
			plan.parallel.map((planned) => planned.label),
			["packages/coding-agent shard 1/3", "packages/coding-agent shard 2/3", "packages/coding-agent shard 3/3"],
		);
		plan.parallel.forEach((planned, index) => {
			assert.equal(workspaceOf(planned), "packages/coding-agent");
			assert.deepEqual(planned.args.slice(-3), ["test", "--", `--shard=${index + 1}/3`]);
		});
	});

	it("covers the real repository's tested workspaces exactly once, as npm test does", async () => {
		const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
		assert.equal(manifest.scripts.test, "npm run test:scripts && node scripts/run-workspaces.mjs --if-present test");
		const workspaces = await resolveWorkspaceDirectories(repoRoot);
		const plan = suite.planForcedTestSuite({ rootDirectory: repoRoot, workspaces });
		const tested = workspaces.filter((entry) => typeof entry.scripts.test === "string").map((entry) => entry.relativePath);
		const covered = [...plan.serial.slice(1).map(workspaceOf), "packages/coding-agent"];
		assert.deepEqual([...covered].sort(), [...tested].sort());
		assert.equal(new Set(covered).size, covered.length);
		assert.equal(plan.parallel.length, suite.FORCED_CODING_AGENT_SHARDS);
		assert.ok(plan.parallel.length >= 2, "coding-agent runs as parallel shards");
		assert.ok(plan.parallel.every((planned) => workspaceOf(planned) === "packages/coding-agent"));
	});
});

describe("runForcedTestSuite (senpi#6139, senpi#2291)", () => {
	it("runs the shards at the same time and logs each step's wall and the total", () =>
		withDir(async (dir) => {
			// Each shard waits until the other has started: a serial run never gets there and dies at the cap.
			const meetsOther = (mine, other) =>
				`${touch(join(dir, mine))}; const t = setInterval(() => { if (require("node:fs").existsSync(${JSON.stringify(join(dir, other))})) clearInterval(t); }, 20);`;
			const lines = [];
			const error = await failureOf({
				plan: { serial: [step("scripts", "")], parallel: [shard(1, 2, meetsOther("a", "b")), shard(2, 2, meetsOther("b", "a"))] },
				timeoutMs: 20_000,
				log: (line) => lines.push(line),
			});
			assert.equal(error, null);
			for (const label of ["scripts", "packages/coding-agent shard 1/2", "packages/coding-agent shard 2/2"]) {
				assert.ok(
					lines.some((line) => line.includes(label) && /passed in \d+\.\d min/.test(line)),
					`no wall line for ${label}: ${lines.join(" | ")}`,
				);
			}
			assert.ok(lines.some((line) => /total wall \d+\.\d min/.test(line)), lines.join(" | "));
		}));

	it("fails the suite when one shard fails, after every shard ran", () =>
		withDir(async (dir) => {
			const error = await failureOf({
				plan: { serial: [], parallel: [shard(1, 2, touch(join(dir, "ran"))), shard(2, 2, "process.exit(3)")] },
				timeoutMs: 20_000,
			});
			assert.ok(error, "a failing shard passed the suite");
			assert.match(error.message, /packages\/coding-agent shard 2\/2 \(exit 3\)/);
			assert.doesNotMatch(error.message, /shard 1\/2/);
			assert.ok(existsSync(join(dir, "ran")), "the passing shard did not run");
		}));

	it("fails the suite when a serial workspace fails, and still runs the coding-agent shards", () =>
		withDir(async (dir) => {
			const error = await failureOf({
				plan: { serial: [step("packages/ai", "process.exit(4)")], parallel: [shard(1, 1, touch(join(dir, "ran")))] },
				timeoutMs: 20_000,
			});
			assert.ok(error, "a failing workspace passed the suite");
			assert.match(error.message, /packages\/ai \(exit 4\)/);
			assert.ok(existsSync(join(dir, "ran")), "the coding-agent shard was skipped");
		}));

	it("kills a hung shard at the cap and names it with its elapsed minutes", async () => {
		const started = Date.now();
		const error = await failureOf({
			plan: { serial: [], parallel: [shard(1, 2, ""), shard(2, 2, HANG)] },
			timeoutMs: 1_500,
		});
		assert.ok(error, "a hung shard passed the suite");
		assert.match(error.message, /packages\/coding-agent shard 2\/2 was still running after \d+\.\d min/);
		assert.doesNotMatch(error.message, /shard 1\/2 was still running/);
		assert.ok(Date.now() - started < 10_000, "the hung shard is killed at the cap, not left running");
	});

	it("names the slow workspace and its elapsed time without calling it a hang, and stops there", () =>
		withDir(async (dir) => {
			const error = await failureOf({
				plan: { serial: [step("packages/ai", HANG)], parallel: [shard(1, 1, touch(join(dir, "ran")))] },
				timeoutMs: 300,
			});
			assert.ok(error, "a suite past its budget passed");
			assert.match(error.message, /0\.005 min budget/);
			assert.match(error.message, /packages\/ai was still running after \d+\.\d min/);
			assert.doesNotMatch(error.message, /hung/);
			assert.equal(existsSync(join(dir, "ran")), false, "the suite kept going past its budget");
		}));

	it("kills the whole step process tree on timeout, including a hung grandchild worker", () =>
		withDir(async (dir) => {
			const pidFile = join(dir, "grandchild.pid");
			const source = `const { spawn } = require("node:child_process"); const g = spawn(process.execPath, ["-e", ${JSON.stringify(HANG)}], { stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); ${HANG};`;
			const error = await failureOf({ plan: { serial: [step("suite", source)], parallel: [] }, timeoutMs: 1_500 });
			assert.match(error?.message ?? "", /suite was still running after/);
			const pid = Number(readFileSync(pidFile, "utf8"));
			const alive = () => {
				try {
					process.kill(pid, 0);
					return true;
				} catch {
					return false;
				}
			};
			const deadline = Date.now() + 5_000;
			while (alive() && Date.now() < deadline) execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 100)"]);
			const survived = alive();
			if (survived) process.kill(pid, "SIGKILL");
			assert.equal(survived, false, "the hung grandchild worker was left running after the timeout");
		}));

	it("passes CI=1 to every serial step and shard", async () => {
		const needsCi = "process.exit(process.env.CI === '1' ? 0 : 3)";
		const error = await failureOf({
			plan: { serial: [step("scripts", needsCi)], parallel: [shard(1, 2, needsCi), shard(2, 2, needsCi)] },
			timeoutMs: 20_000,
		});
		assert.equal(error, null);
	});
});
