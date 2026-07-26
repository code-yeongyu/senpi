import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	computeRemoteState,
	defaultRun,
	detectOmoLocalInstall,
	isKillSwitched,
	type OmoLocalRun,
	OmoLocalStepError,
	type OmoLocalUpdateStamp,
	omoLocalUpdateBuildWorktreePath,
	omoLocalUpdateLockPath,
	omoLocalUpdateStampPath,
	readStamp,
	runOmoLocalUpdateBeta,
	shouldSkipUpdate,
	swapPluginDir,
	writeStamp,
} from "../src/beta/omo-local-update.ts";
import {
	advanceOriginDev,
	createOmoFixture,
	dirtySource,
	dirtyUntracked,
	FIXTURE_PLUGIN_ARTIFACTS,
} from "./omo-local-update-fixture.ts";

// Git determinism: isolate every git invocation in this file (test-side AND
// engine-side through the inherited process.env) from ambient host config.
const gitConfigDir = mkdtempSync(join(tmpdir(), "omo-local-update-gitcfg-"));
const emptyGitConfig = join(gitConfigDir, "config");
writeFileSync(emptyGitConfig, "");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = emptyGitConfig;
process.env.GIT_AUTHOR_NAME = "senpi-test";
process.env.GIT_AUTHOR_EMAIL = "senpi-test@example.com";
process.env.GIT_COMMITTER_NAME = "senpi-test";
process.env.GIT_COMMITTER_EMAIL = "senpi-test@example.com";

const tempRoots: string[] = [];

function makeTempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "omo-local-update-test-"));
	tempRoots.push(root);
	return root;
}

afterAll(() => {
	for (const root of tempRoots) {
		rmSync(root, { recursive: true, force: true });
	}
	rmSync(gitConfigDir, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

interface LayoutOptions {
	pluginPkgName?: string;
	withOmoSenpiWorkspace?: boolean;
	withSenpiTask?: boolean;
	gitInit?: boolean;
}

function makeOmoLayout(
	root: string,
	options: LayoutOptions = {},
): { repoRoot: string; pluginPath: string; agentDir: string } {
	const repoRoot = join(root, "omo");
	const pluginPath = join(repoRoot, "packages", "omo-senpi", "plugin");
	const agentDir = join(root, "agent");
	mkdirSync(pluginPath, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(pluginPath, "package.json"),
		JSON.stringify({ name: options.pluginPkgName ?? "@code-yeongyu/omo-senpi" }),
	);
	if (options.withOmoSenpiWorkspace ?? true) {
		writeFileSync(
			join(repoRoot, "packages", "omo-senpi", "package.json"),
			JSON.stringify({ name: "@oh-my-opencode/omo-senpi" }),
		);
	}
	if (options.withSenpiTask ?? true) {
		mkdirSync(join(repoRoot, "packages", "senpi-task"), { recursive: true });
		writeFileSync(
			join(repoRoot, "packages", "senpi-task", "package.json"),
			JSON.stringify({ name: "@oh-my-opencode/senpi-task" }),
		);
	}
	if (options.gitInit ?? true) {
		git(["-c", "init.defaultBranch=main", "init"], repoRoot);
	}
	return { repoRoot, pluginPath, agentDir };
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function headSha(cwd: string): string {
	return git(["rev-parse", "HEAD"], cwd);
}

function currentBranch(cwd: string): string | undefined {
	try {
		return git(["symbolic-ref", "--short", "-q", "HEAD"], cwd) || undefined;
	} catch {
		return undefined;
	}
}

function makeLogCollector(): { lines: string[]; log: (message: string) => void } {
	const lines: string[] = [];
	return {
		lines,
		log: (message: string) => {
			lines.push(message);
		},
	};
}

function makeSpyRun(): { calls: string[][]; run: OmoLocalRun } {
	const calls: string[][] = [];
	return {
		calls,
		run: (command, args, options) => {
			calls.push([command, ...args]);
			return defaultRun(command, args, options);
		},
	};
}

async function captureFailure(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
		return undefined;
	} catch (error) {
		return error;
	}
}

/** Content snapshot of every file under dir: posix relative path -> sha256 of bytes. */
function snapshotDir(dir: string): Record<string, string> {
	const snapshot: Record<string, string> = {};
	const pending = [dir];
	while (pending.length > 0) {
		const current = pending.pop();
		if (current === undefined) continue;
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				pending.push(full);
			} else if (entry.isFile()) {
				const key = relative(dir, full).split("/").join("/");
				snapshot[key] = createHash("sha256").update(readFileSync(full)).digest("hex");
			}
		}
	}
	return snapshot;
}

function artifactMtimes(pluginPath: string): Record<string, number> {
	const mtimes: Record<string, number> = {};
	for (const artifact of FIXTURE_PLUGIN_ARTIFACTS) {
		mtimes[artifact] = statSync(join(pluginPath, artifact)).mtimeMs;
	}
	return mtimes;
}

/**
 * Executable `bun` stand-in for orchestrator tests: `bun install` succeeds quietly;
 * `bun run build:senpi-plugin` runs the fixture's real stub build from the spawn cwd
 * (the updater's build worktree). FAKE_BUN_BUILD_FAIL makes the build exit 1 after
 * the stub wrote its artifacts into the worktree.
 */
function installFakeBun(binDir: string): void {
	mkdirSync(binDir, { recursive: true });
	const script = [
		"#!/bin/sh",
		'if [ "$1" = "install" ]; then',
		'  echo "fake bun install: ok"',
		"  exit 0",
		"fi",
		'if [ "$1" = "run" ] && [ "$2" = "build:senpi-plugin" ]; then',
		"  node scripts/build-senpi-plugin.mjs",
		"  build_status=$?",
		'  if [ -n "$FAKE_BUN_BUILD_FAIL" ]; then',
		'    echo "fake bun: simulated build failure" >&2',
		"    exit 1",
		"  fi",
		"  exit $build_status",
		"fi",
		'echo "fake bun: unexpected argv: $*" >&2',
		"exit 1",
		"",
	].join("\n");
	const bunPath = join(binDir, "bun");
	writeFileSync(bunPath, script);
	chmodSync(bunPath, 0o755);
}

/** Prepend binDir to PATH; returns a restore function. */
function withPrependedPath(binDir: string): () => void {
	const originalPath = process.env.PATH;
	process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
	return () => {
		if (originalPath === undefined) {
			delete process.env.PATH;
		} else {
			process.env.PATH = originalPath;
		}
	};
}

function makeAgentDir(root: string): string {
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	return agentDir;
}

describe("isKillSwitched", () => {
	it("returns true only for the literal '0'", () => {
		expect(isKillSwitched({ SENPI_OMO_LOCAL_UPDATE: "0" })).toBe(true);
		expect(isKillSwitched({ SENPI_OMO_LOCAL_UPDATE: "1" })).toBe(false);
		expect(isKillSwitched({ SENPI_OMO_LOCAL_UPDATE: "" })).toBe(false);
		expect(isKillSwitched({})).toBe(false);
	});
});

describe("defaultRun process seam", () => {
	it("captures stdout and stderr and resolves the exit code", async () => {
		const result = await defaultRun(
			process.execPath,
			["-e", 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3);'],
			{},
		);
		expect(result.code).toBe(3);
		expect(result.stdout).toBe("out");
		expect(result.stderr).toBe("err");
		expect(result.timedOut).toBe(false);
	});

	it("merges options.env over process.env", async () => {
		process.env.OMO_LOCAL_UPDATE_SEAM_AMBIENT = "base";
		const result = await defaultRun(
			process.execPath,
			[
				"-e",
				"console.log(JSON.stringify({ injected: process.env.OMO_LOCAL_UPDATE_SEAM_TEST ?? null, overridden: process.env.OMO_LOCAL_UPDATE_SEAM_AMBIENT ?? null, hasPath: Boolean(process.env.PATH) }));",
			],
			{ env: { OMO_LOCAL_UPDATE_SEAM_TEST: "hello", OMO_LOCAL_UPDATE_SEAM_AMBIENT: "override" } },
		);
		const printed = JSON.parse(result.stdout.trim()) as {
			injected: string | null;
			overridden: string | null;
			hasPath: boolean;
		};
		expect(printed.injected).toBe("hello");
		expect(printed.overridden).toBe("override");
		expect(printed.hasPath).toBe(true);
	});

	it("kills the whole process tree and reports timedOut on timeout", async () => {
		// The grandchild INHERITS the child's stdout pipe (fd 1), so the seam's stdout stream
		// only reaches EOF once BOTH processes have released it - i.e. once the whole tree is
		// dead. defaultRun resolves on that stream close, which makes this proof event-driven:
		// no wall-clock deadline, no liveness polling, nothing that can pass by timing luck.
		const script = [
			'const { spawn } = require("node:child_process");',
			'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", 1, "ignore"] });',
			"console.log(JSON.stringify({ self: process.pid, grandchild: grandchild.pid }));",
			"setInterval(() => {}, 1000);",
		].join("\n");
		const result = await defaultRun(process.execPath, ["-e", script], { timeoutMs: 500 });
		expect(result.timedOut).toBe(true);
		const pids = JSON.parse(result.stdout.trim()) as { self: number; grandchild: number };
		// Pipe EOF already proved both processes released fd 1, which only happens at exit.
		expect(pidAlive(pids.self)).toBe(false);
		expect(pidAlive(pids.grandchild)).toBe(false);
	});
});

describe("detectOmoLocalInstall", () => {
	it("returns undefined when the packages key is absent", async () => {
		const root = makeTempRoot();
		const { agentDir } = makeOmoLayout(root);
		expect(await detectOmoLocalInstall({ packages: undefined, agentDir, run: defaultRun })).toBeUndefined();
	});

	it("returns undefined for npm-only and git-only entries", async () => {
		const root = makeTempRoot();
		const { agentDir } = makeOmoLayout(root);
		expect(
			await detectOmoLocalInstall({
				packages: ["npm:@code-yeongyu/omo-senpi", "git:https://example.com/omo.git"],
				agentDir,
				run: defaultRun,
			}),
		).toBeUndefined();
	});

	it("returns undefined when the plugin package name does not match", async () => {
		const root = makeTempRoot();
		const { pluginPath, agentDir } = makeOmoLayout(root, { pluginPkgName: "@code-yeongyu/not-omo" });
		expect(await detectOmoLocalInstall({ packages: [pluginPath], agentDir, run: defaultRun })).toBeUndefined();
	});

	it("returns undefined when the senpi-task workspace package is missing", async () => {
		const root = makeTempRoot();
		const { pluginPath, agentDir } = makeOmoLayout(root, { withSenpiTask: false });
		expect(await detectOmoLocalInstall({ packages: [pluginPath], agentDir, run: defaultRun })).toBeUndefined();
	});

	it("returns undefined when the omo-senpi workspace package is missing", async () => {
		const root = makeTempRoot();
		const { pluginPath, agentDir } = makeOmoLayout(root, { withOmoSenpiWorkspace: false });
		expect(await detectOmoLocalInstall({ packages: [pluginPath], agentDir, run: defaultRun })).toBeUndefined();
	});

	it("returns undefined when the derived repo root is not a git repository", async () => {
		const root = makeTempRoot();
		const { pluginPath, agentDir } = makeOmoLayout(root, { gitInit: false });
		expect(await detectOmoLocalInstall({ packages: [pluginPath], agentDir, run: defaultRun })).toBeUndefined();
	});

	it("returns undefined when the git toplevel is an enclosing repository", async () => {
		const root = makeTempRoot();
		git(["-c", "init.defaultBranch=main", "init"], root);
		const { pluginPath, agentDir } = makeOmoLayout(root, { gitInit: false });
		expect(await detectOmoLocalInstall({ packages: [pluginPath], agentDir, run: defaultRun })).toBeUndefined();
	});

	it("resolves pluginPath and repoRoot for an absolute settings entry", async () => {
		const root = makeTempRoot();
		const { repoRoot, pluginPath, agentDir } = makeOmoLayout(root);
		const install = await detectOmoLocalInstall({ packages: [pluginPath], agentDir, run: defaultRun });
		expect(install).toEqual({ pluginPath: resolve(pluginPath), repoRoot: resolve(repoRoot) });
	});

	it("resolves a relative settings entry against agentDir", async () => {
		const root = makeTempRoot();
		const { repoRoot, pluginPath, agentDir } = makeOmoLayout(root);
		const relativeEntry = relative(agentDir, pluginPath);
		const install = await detectOmoLocalInstall({ packages: [relativeEntry], agentDir, run: defaultRun });
		expect(install).toEqual({ pluginPath: resolve(pluginPath), repoRoot: resolve(repoRoot) });
	});

	it("expands a ~-prefixed settings entry against the home directory", async () => {
		const root = makeTempRoot();
		const { repoRoot, pluginPath, agentDir } = makeOmoLayout(root);
		const originalHome = process.env.HOME;
		process.env.HOME = root;
		try {
			const install = await detectOmoLocalInstall({
				packages: ["~/omo/packages/omo-senpi/plugin"],
				agentDir,
				run: defaultRun,
			});
			expect(install).toEqual({ pluginPath: resolve(pluginPath), repoRoot: resolve(repoRoot) });
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
		}
	});

	it("accepts object-form PackageSource entries", async () => {
		const root = makeTempRoot();
		const { repoRoot, pluginPath, agentDir } = makeOmoLayout(root);
		const install = await detectOmoLocalInstall({
			packages: [{ source: pluginPath, autoload: true }],
			agentDir,
			run: defaultRun,
		});
		expect(install).toEqual({ pluginPath: resolve(pluginPath), repoRoot: resolve(repoRoot) });
	});

	it("skips non-matching entries and finds a later matching one", async () => {
		const root = makeTempRoot();
		const { repoRoot, pluginPath, agentDir } = makeOmoLayout(root);
		const install = await detectOmoLocalInstall({
			packages: ["npm:@scope/other", join(root, "does-not-exist"), { source: pluginPath }],
			agentDir,
			run: defaultRun,
		});
		expect(install).toEqual({ pluginPath: resolve(pluginPath), repoRoot: resolve(repoRoot) });
	});

	it("honors injected readJson, exists and run seams", async () => {
		const pluginPath = join("/virtual", "omo", "packages", "omo-senpi", "plugin");
		const repoRoot = join("/virtual", "omo");
		const names = new Map<string, string>([
			[join(pluginPath, "package.json"), "@code-yeongyu/omo-senpi"],
			[join(repoRoot, "packages", "omo-senpi", "package.json"), "@oh-my-opencode/omo-senpi"],
			[join(repoRoot, "packages", "senpi-task", "package.json"), "@oh-my-opencode/senpi-task"],
		]);
		const install = await detectOmoLocalInstall({
			packages: [pluginPath],
			agentDir: "/virtual/agent",
			readJson: (path) => {
				const name = names.get(path);
				return name === undefined ? undefined : { name };
			},
			exists: (path) => names.has(path),
			run: async () => ({ code: 0, stdout: `${realpathSync("/")}virtual${"/"}omo\n`, stderr: "", timedOut: false }),
		});
		expect(install).toEqual({ pluginPath, repoRoot });
	});
});

describe("readStamp/writeStamp", () => {
	const stamp: OmoLocalUpdateStamp = {
		repoRoot: "/some/repo",
		sha: "0123456789abcdef",
		omoSenpiTree: "tree-omo",
		senpiTaskTree: "tree-task",
		installedAt: "2026-07-25T00:00:00.000Z",
		artifacts: ["extensions/omo.js", "scripts/install.mjs"],
	};

	it("round-trips a stamp through the agent dir state file", () => {
		const agentDir = join(makeTempRoot(), "agent");
		writeStamp(agentDir, stamp);
		expect(readStamp(agentDir)).toEqual(stamp);
	});

	it("returns undefined when no stamp file exists", () => {
		const agentDir = join(makeTempRoot(), "agent");
		mkdirSync(agentDir, { recursive: true });
		expect(readStamp(agentDir)).toBeUndefined();
	});

	it("returns undefined for a corrupt stamp file", () => {
		const agentDir = join(makeTempRoot(), "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(omoLocalUpdateStampPath(agentDir), "{ not json");
		expect(readStamp(agentDir)).toBeUndefined();
	});

	it("returns undefined for a stamp with an invalid shape", () => {
		const agentDir = join(makeTempRoot(), "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			omoLocalUpdateStampPath(agentDir),
			JSON.stringify({ repoRoot: "/some/repo", sha: 42, installedAt: "now", artifacts: "nope" }),
		);
		expect(readStamp(agentDir)).toBeUndefined();
		// A v1-shaped stamp (builtSha/builtAt, no trees) is equally invalid -> update path.
		writeFileSync(
			omoLocalUpdateStampPath(agentDir),
			JSON.stringify({ repoRoot: "/some/repo", builtSha: "abc", builtAt: "now", artifacts: [] }),
		);
		expect(readStamp(agentDir)).toBeUndefined();
	});
});

describe("shouldSkipUpdate", () => {
	const stamp: OmoLocalUpdateStamp = {
		repoRoot: "/repo",
		sha: "abc123",
		omoSenpiTree: "tree-omo",
		senpiTaskTree: "tree-task",
		installedAt: "2026-07-25T00:00:00.000Z",
		artifacts: ["extensions/omo.js"],
	};
	const base = {
		stamp,
		repoRoot: "/repo",
		remoteSha: "abc123",
		stampArtifactsExist: true,
		force: false,
	};

	it("skips when the stamp matches, the full inventory exists, and force is off", () => {
		expect(shouldSkipUpdate(base)).toBe(true);
	});

	it("updates when force is set", () => {
		expect(shouldSkipUpdate({ ...base, force: true })).toBe(false);
	});

	it("updates when the remote sha moved", () => {
		expect(shouldSkipUpdate({ ...base, remoteSha: "def456" })).toBe(false);
	});

	it("updates when any inventoried artifact is missing", () => {
		expect(shouldSkipUpdate({ ...base, stampArtifactsExist: false })).toBe(false);
	});

	it("updates when the inventory is empty", () => {
		expect(shouldSkipUpdate({ ...base, stamp: { ...stamp, artifacts: [] } })).toBe(false);
	});

	it("updates when no stamp exists at all", () => {
		expect(shouldSkipUpdate({ ...base, stamp: undefined })).toBe(false);
	});

	it("updates when the stamp belongs to a different repo root", () => {
		expect(shouldSkipUpdate({ ...base, repoRoot: "/other/repo" })).toBe(false);
	});
});

describe("computeRemoteState", () => {
	it("returns the frozen sha, subject, and both package trees from origin/dev", { timeout: 30000 }, async () => {
		const fixture = createOmoFixture(makeTempRoot());
		const state = await computeRemoteState({ repoRoot: fixture.repoRoot, run: defaultRun });
		expect(state.sha).toBe(git(["rev-parse", "origin/dev"], fixture.repoRoot));
		expect(state.subject).toBe("fixture: seed fake omo repo");
		expect(state.omoSenpiTree).toBe(git(["rev-parse", "origin/dev:packages/omo-senpi"], fixture.repoRoot));
		expect(state.senpiTaskTree).toBe(git(["rev-parse", "origin/dev:packages/senpi-task"], fixture.repoRoot));
	});

	it("moves only the omo-senpi tree when the omo-senpi package dir is touched", { timeout: 30000 }, async () => {
		const fixture = createOmoFixture(makeTempRoot());
		const before = await computeRemoteState({ repoRoot: fixture.repoRoot, run: defaultRun });
		const newSha = advanceOriginDev({ originDir: fixture.originDir, touch: "omo-senpi" });
		const after = await computeRemoteState({ repoRoot: fixture.repoRoot, run: defaultRun });
		expect(after.sha).toBe(newSha);
		expect(after.sha).not.toBe(before.sha);
		expect(after.subject).toBe("origin dev commit 2");
		expect(after.omoSenpiTree).not.toBe(before.omoSenpiTree);
		expect(after.senpiTaskTree).toBe(before.senpiTaskTree);
	});

	it("moves only the senpi-task tree for a senpi-task touch, and neither tree for other dirs", {
		timeout: 30000,
	}, async () => {
		const fixture = createOmoFixture(makeTempRoot());
		await computeRemoteState({ repoRoot: fixture.repoRoot, run: defaultRun });
		advanceOriginDev({ originDir: fixture.originDir, touch: "senpi-task" });
		const taskTouch = await computeRemoteState({ repoRoot: fixture.repoRoot, run: defaultRun });
		const omoTreeAtTaskTouch = taskTouch.omoSenpiTree;
		const taskTreeAtTaskTouch = taskTouch.senpiTaskTree;
		expect(taskTreeAtTaskTouch).not.toBe(git(["rev-parse", "origin/dev~1:packages/senpi-task"], fixture.repoRoot));
		expect(omoTreeAtTaskTouch).toBe(git(["rev-parse", "origin/dev:packages/omo-senpi"], fixture.repoRoot));

		const otherSha = advanceOriginDev({ originDir: fixture.originDir, touch: "other" });
		const otherTouch = await computeRemoteState({ repoRoot: fixture.repoRoot, run: defaultRun });
		expect(otherTouch.sha).toBe(otherSha);
		expect(otherTouch.sha).not.toBe(taskTouch.sha);
		expect(otherTouch.omoSenpiTree).toBe(omoTreeAtTaskTouch);
		expect(otherTouch.senpiTaskTree).toBe(taskTreeAtTaskTouch);
	});

	it("rejects with a fetch-stage error when origin is gone, leaving the repo untouched", {
		timeout: 30000,
	}, async () => {
		const fixture = createOmoFixture(makeTempRoot());
		const headBefore = headSha(fixture.repoRoot);
		git(["remote", "remove", "origin"], fixture.repoRoot);
		const failure = await captureFailure(computeRemoteState({ repoRoot: fixture.repoRoot, run: defaultRun }));
		expect(failure).toBeInstanceOf(OmoLocalStepError);
		expect((failure as OmoLocalStepError).stage).toBe("fetch");
		expect(headSha(fixture.repoRoot)).toBe(headBefore);
		expect(git(["status", "--porcelain"], fixture.repoRoot)).toBe("");
	});
});

describe("swapPluginDir", () => {
	it("atomically replaces the plugin dir with the built source dir", () => {
		const root = makeTempRoot();
		const pluginPath = join(root, "plugin");
		const sourceDir = join(root, "built");
		mkdirSync(pluginPath, { recursive: true });
		writeFileSync(join(pluginPath, "old.txt"), "old\n");
		mkdirSync(join(sourceDir, "sub"), { recursive: true });
		writeFileSync(join(sourceDir, "sub", "new.txt"), "new\n");
		swapPluginDir({ pluginPath, sourceDir });
		expect(existsSync(join(pluginPath, "old.txt"))).toBe(false);
		expect(readFileSync(join(pluginPath, "sub", "new.txt"), "utf8")).toBe("new\n");
		expect(readdirSync(root).filter((entry) => entry.includes(".staging-") || entry.includes(".prev-"))).toEqual([]);
	});

	it("restores the previous plugin dir byte-exact when the staging rename fails", () => {
		const root = makeTempRoot();
		const pluginPath = join(root, "plugin");
		const sourceDir = join(root, "built");
		mkdirSync(join(pluginPath, "nested"), { recursive: true });
		writeFileSync(join(pluginPath, "nested", "keep.txt"), "keep me\n");
		mkdirSync(sourceDir, { recursive: true });
		writeFileSync(join(sourceDir, "new.txt"), "new\n");
		const before = snapshotDir(pluginPath);
		const failingFs = {
			cpSync: (source: string, destination: string) => {
				cpSync(source, destination, { recursive: true });
			},
			renameSync: (oldPath: string, newPath: string) => {
				if (oldPath.includes(".staging-") && newPath === pluginPath) {
					throw new Error("simulated staging rename failure");
				}
				renameSync(oldPath, newPath);
			},
			rmSync: (path: string) => {
				rmSync(path, { recursive: true, force: true });
			},
		};
		expect(() => swapPluginDir({ pluginPath, sourceDir, fs: failingFs })).toThrow("simulated staging rename failure");
		expect(snapshotDir(pluginPath)).toEqual(before);
		expect(readdirSync(root).filter((entry) => entry.includes(".staging-") || entry.includes(".prev-"))).toEqual([]);
	});
});

describe("runOmoLocalUpdateBeta gates", () => {
	it("no-ops under the kill-switch", async () => {
		const root = makeTempRoot();
		const { pluginPath, agentDir } = makeOmoLayout(root);
		await expect(
			runOmoLocalUpdateBeta({
				env: { SENPI_OMO_LOCAL_UPDATE: "0" },
				agentDir,
				settings: { packages: [pluginPath] },
			}),
		).resolves.toBeUndefined();
		expect(readStamp(agentDir)).toBeUndefined();
	});

	it("no-ops when nothing is detected", async () => {
		const root = makeTempRoot();
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		await expect(
			runOmoLocalUpdateBeta({ env: {}, agentDir, settings: { packages: ["npm:@scope/other"] } }),
		).resolves.toBeUndefined();
	});
});

describe("runOmoLocalUpdateBeta orchestrator", () => {
	it("replaces only the plugin install on update, leaving the checkout byte- and ref-identical", {
		timeout: 90000,
	}, async () => {
		const root = makeTempRoot();
		const fixture = createOmoFixture(root);
		const agentDir = makeAgentDir(root);
		const binDir = join(root, "bin");
		installFakeBun(binDir);
		const restorePath = withPrependedPath(binDir);

		const newSha = advanceOriginDev({ originDir: fixture.originDir, touch: "omo-senpi" });
		// Pre-seed user dirt that must survive the update untouched.
		const sourcePath = dirtySource(fixture.repoRoot);
		const untrackedPath = dirtyUntracked(fixture.repoRoot);
		const sourceBefore = readFileSync(join(fixture.repoRoot, sourcePath), "utf8");
		const untrackedBefore = readFileSync(join(fixture.repoRoot, untrackedPath), "utf8");
		const branchBefore = currentBranch(fixture.repoRoot);
		const devShaBefore = git(["rev-parse", "dev"], fixture.repoRoot);
		const branchesBefore = git(["branch", "--format=%(refname:short)"], fixture.repoRoot);
		const diffBefore = git(["diff", "--name-only"], fixture.repoRoot).split("\n").filter(Boolean).sort();

		const { calls, run } = makeSpyRun();
		const { lines, log } = makeLogCollector();
		try {
			await expect(
				runOmoLocalUpdateBeta({
					env: {},
					agentDir,
					settings: { packages: [fixture.pluginPath] },
					log,
					run,
				}),
			).resolves.toBeUndefined();
		} finally {
			restorePath();
		}

		const short = newSha.slice(0, 7);
		expect(lines).toContain(
			`Updated OMO local plugins (omo-senpi + senpi-task) to origin/dev @${short} - origin dev commit 2`,
		);
		expect(lines.some((line) => line.includes("Updating OMO local plugins: fetching origin/dev..."))).toBe(true);
		expect(lines.some((line) => line.includes("Updating OMO local plugins: installing deps..."))).toBe(true);
		expect(lines.some((line) => line.includes("Updating OMO local plugins: building plugin..."))).toBe(true);
		expect(calls).toContainEqual(["bun", "install"]);
		expect(calls).toContainEqual(["bun", "run", "build:senpi-plugin"]);

		// The plugin install was replaced with content built from the NEW origin/dev commit.
		expect(readFileSync(join(fixture.pluginPath, "extensions/omo.js"), "utf8")).toContain("marker: marker-2");
		for (const artifact of FIXTURE_PLUGIN_ARTIFACTS) {
			expect(existsSync(join(fixture.pluginPath, artifact))).toBe(true);
		}
		// No staging/prev leftovers next to the install target.
		expect(
			readdirSync(dirname(fixture.pluginPath)).filter(
				(entry) => entry.includes(".staging-") || entry.includes(".prev-"),
			),
		).toEqual([]);

		// Stamp written from the NEW plugin dir inventory, with both package trees.
		const stamp = readStamp(agentDir);
		expect(stamp?.repoRoot).toBe(fixture.repoRoot);
		expect(stamp?.sha).toBe(newSha);
		expect(stamp?.omoSenpiTree).toBe(git(["rev-parse", "origin/dev:packages/omo-senpi"], fixture.repoRoot));
		expect(stamp?.senpiTaskTree).toBe(git(["rev-parse", "origin/dev:packages/senpi-task"], fixture.repoRoot));
		expect(stamp?.artifacts).toEqual([...FIXTURE_PLUGIN_ARTIFACTS].sort());

		// === CHECKOUT PRESERVATION (load-bearing) ===
		expect(currentBranch(fixture.repoRoot)).toBe(branchBefore);
		expect(branchBefore).toBe("dev");
		expect(git(["rev-parse", "dev"], fixture.repoRoot)).toBe(devShaBefore); // no new commits on any branch
		expect(git(["branch", "--format=%(refname:short)"], fixture.repoRoot)).toBe(branchesBefore);
		expect(git(["branch", "--list", "backup/*"], fixture.repoRoot)).toBe(""); // no backup branches ever
		expect(readFileSync(join(fixture.repoRoot, sourcePath), "utf8")).toBe(sourceBefore); // byte-exact dirt
		expect(readFileSync(join(fixture.repoRoot, untrackedPath), "utf8")).toBe(untrackedBefore);
		const diffAfter = git(["diff", "--name-only"], fixture.repoRoot).split("\n").filter(Boolean).sort();
		for (const path of diffBefore) {
			expect(diffAfter).toContain(path);
		}
		for (const path of diffAfter) {
			if (!diffBefore.includes(path)) {
				expect(path.startsWith("packages/omo-senpi/plugin/")).toBe(true);
			}
		}
		expect(diffAfter).toContain("packages/omo-senpi/plugin/extensions/omo.js");
		// The untracked set is exactly the pre-seeded notes file (no leftovers anywhere).
		expect(
			git(["ls-files", "--others", "--exclude-standard"], fixture.repoRoot).split("\n").filter(Boolean).sort(),
		).toEqual([untrackedPath]);
		expect(existsSync(omoLocalUpdateLockPath(agentDir))).toBe(false);
	});

	it("reuses the persistent build worktree across updates and reports per-package tree changes", {
		timeout: 90000,
	}, async () => {
		const root = makeTempRoot();
		const fixture = createOmoFixture(root);
		const agentDir = makeAgentDir(root);
		const binDir = join(root, "bin");
		installFakeBun(binDir);
		const restorePath = withPrependedPath(binDir);
		const base = { env: {}, agentDir, settings: { packages: [fixture.pluginPath] }, run: defaultRun };
		try {
			const first = makeLogCollector();
			await runOmoLocalUpdateBeta({ ...base, log: first.log });
			expect(first.lines.some((line) => line.includes("Updated OMO local plugins"))).toBe(true);
			// First update: no previous stamp -> no per-package compare line.
			expect(first.lines.some((line) => line.includes("omo-senpi:"))).toBe(false);

			const wt = omoLocalUpdateBuildWorktreePath(agentDir);
			expect(existsSync(wt)).toBe(true);
			writeFileSync(join(wt, "update-canary.txt"), "survives checkout --force\n");

			const newSha = advanceOriginDev({ originDir: fixture.originDir, touch: "omo-senpi" });
			const second = makeLogCollector();
			await runOmoLocalUpdateBeta({ ...base, log: second.log });
			expect(second.lines.some((line) => line.includes("Updated OMO local plugins"))).toBe(true);
			// Old stamp existed -> dim per-package tree comparison.
			expect(second.lines).toContain("omo-senpi: updated, senpi-task: unchanged");

			// SAME worktree reused: the untracked canary survived `checkout --detach --force`.
			expect(readFileSync(join(wt, "update-canary.txt"), "utf8")).toBe("survives checkout --force\n");
			expect(git(["-C", wt, "rev-parse", "HEAD"], ".")).toBe(newSha);
			// Registered exactly once (no duplicate worktree add).
			const registrations = git(["worktree", "list", "--porcelain"], fixture.repoRoot)
				.split("\n")
				.filter((line) => line.startsWith("worktree ") && line.includes("build-worktree"));
			expect(registrations).toHaveLength(1);
			expect(readStamp(agentDir)?.sha).toBe(newSha);
			expect(readFileSync(join(fixture.pluginPath, "extensions/omo.js"), "utf8")).toContain("marker: marker-2");
		} finally {
			restorePath();
		}
	});

	it("removes a foreign directory at the build-worktree path and recreates it as a real worktree", {
		timeout: 90000,
	}, async () => {
		const root = makeTempRoot();
		const fixture = createOmoFixture(root);
		const agentDir = makeAgentDir(root);
		const binDir = join(root, "bin");
		installFakeBun(binDir);
		const restorePath = withPrependedPath(binDir);
		const wt = omoLocalUpdateBuildWorktreePath(agentDir);
		mkdirSync(wt, { recursive: true });
		writeFileSync(join(wt, "foreign-canary.txt"), "junk\n");
		const { lines, log } = makeLogCollector();
		try {
			await runOmoLocalUpdateBeta({
				env: {},
				agentDir,
				settings: { packages: [fixture.pluginPath] },
				log,
				run: defaultRun,
			});
		} finally {
			restorePath();
		}
		expect(lines.some((line) => line.includes("Updated OMO local plugins"))).toBe(true);
		expect(existsSync(join(wt, "foreign-canary.txt"))).toBe(false);
		const commonDir = git(["-C", wt, "rev-parse", "--git-common-dir"], ".");
		expect(realpathSync(resolve(wt, commonDir))).toBe(realpathSync(join(fixture.repoRoot, ".git")));
		expect(readStamp(agentDir)?.sha).toBe(git(["rev-parse", "origin/dev"], fixture.repoRoot));
	});

	it("build failure leaves the local install byte-untouched, writes no stamp, and never throws", {
		timeout: 90000,
	}, async () => {
		const root = makeTempRoot();
		const fixture = createOmoFixture(root);
		const agentDir = makeAgentDir(root);
		const binDir = join(root, "bin");
		installFakeBun(binDir);
		const restorePath = withPrependedPath(binDir);
		process.env.FAKE_BUN_BUILD_FAIL = "1";
		const pluginBefore = snapshotDir(fixture.pluginPath);
		const statusBefore = git(["status", "--porcelain"], fixture.repoRoot);
		const { lines, log } = makeLogCollector();
		try {
			await expect(
				runOmoLocalUpdateBeta({
					env: {},
					agentDir,
					settings: { packages: [fixture.pluginPath] },
					log,
					run: defaultRun,
				}),
			).resolves.toBeUndefined();
		} finally {
			restorePath();
			delete process.env.FAKE_BUN_BUILD_FAIL;
		}
		expect(lines.some((line) => line.includes("OMO local plugin update failed (build):"))).toBe(true);
		// The failed step's output tail is echoed dim (the stub ran before exiting 1).
		expect(lines.some((line) => line.includes("fixture build:senpi-plugin wrote"))).toBe(true);
		expect(lines.some((line) => line.includes("To update manually:"))).toBe(true);
		expect(lines.some((line) => line.includes("Updated OMO local plugins"))).toBe(false);
		expect(readStamp(agentDir)).toBeUndefined();
		expect(existsSync(omoLocalUpdateLockPath(agentDir))).toBe(false);
		// The local install is byte-identical; the checkout saw zero mutations.
		expect(snapshotDir(fixture.pluginPath)).toEqual(pluginBefore);
		expect(git(["status", "--porcelain"], fixture.repoRoot)).toBe(statusBefore);
		expect(git(["branch", "--list", "backup/*"], fixture.repoRoot)).toBe("");
	});

	it("skips a second run entirely, and declines the skip when a stamped artifact is deleted", {
		timeout: 90000,
	}, async () => {
		const root = makeTempRoot();
		const fixture = createOmoFixture(root);
		const agentDir = makeAgentDir(root);
		const binDir = join(root, "bin");
		installFakeBun(binDir);
		const restorePath = withPrependedPath(binDir);
		const { calls, run } = makeSpyRun();
		const targetSha = git(["rev-parse", "origin/dev"], fixture.repoRoot);
		const short = targetSha.slice(0, 7);
		const base = { env: {}, agentDir, settings: { packages: [fixture.pluginPath] }, run };
		try {
			const first = makeLogCollector();
			await runOmoLocalUpdateBeta({ ...base, log: first.log });
			expect(first.lines.some((line) => line.includes("Updated OMO local plugins"))).toBe(true);
			const mtimesBefore = artifactMtimes(fixture.pluginPath);

			// Second run: dim skip line, plugin mtimes unchanged, ZERO bun/worktree activity.
			calls.length = 0;
			const second = makeLogCollector();
			await runOmoLocalUpdateBeta({ ...base, log: second.log });
			expect(second.lines.some((line) => line.includes(`already at origin/dev @${short}`))).toBe(true);
			expect(second.lines.some((line) => line.includes("Updated OMO local plugins"))).toBe(false);
			expect(calls.some(([command]) => command === "bun")).toBe(false);
			expect(calls.some(([, ...args]) => args.includes("worktree"))).toBe(false);
			expect(calls.some(([, ...args]) => args.includes("checkout"))).toBe(false);
			expect(artifactMtimes(fixture.pluginPath)).toEqual(mtimesBefore);

			// Deleting one stamped artifact declines the skip -> full update again.
			const stampedSkill = join(fixture.pluginPath, "skills", "alpha", "SKILL.md");
			expect(readStamp(agentDir)?.artifacts).toContain("skills/alpha/SKILL.md");
			rmSync(stampedSkill);
			calls.length = 0;
			const third = makeLogCollector();
			await runOmoLocalUpdateBeta({ ...base, log: third.log });
			expect(third.lines.some((line) => line.includes("Updated OMO local plugins"))).toBe(true);
			expect(calls).toContainEqual(["bun", "install"]);
			expect(calls).toContainEqual(["bun", "run", "build:senpi-plugin"]);
			expect(existsSync(stampedSkill)).toBe(true);
		} finally {
			restorePath();
		}
	});

	it("rebuilds when force is set even with a matching stamp", { timeout: 90000 }, async () => {
		const root = makeTempRoot();
		const fixture = createOmoFixture(root);
		const agentDir = makeAgentDir(root);
		const binDir = join(root, "bin");
		installFakeBun(binDir);
		const restorePath = withPrependedPath(binDir);
		const { calls, run } = makeSpyRun();
		const base = { env: {}, agentDir, settings: { packages: [fixture.pluginPath] }, run };
		try {
			const first = makeLogCollector();
			await runOmoLocalUpdateBeta({ ...base, log: first.log });
			expect(first.lines.some((line) => line.includes("Updated OMO local plugins"))).toBe(true);
			calls.length = 0;
			const second = makeLogCollector();
			await runOmoLocalUpdateBeta({ ...base, force: true, log: second.log });
			expect(second.lines.some((line) => line.includes("Updated OMO local plugins"))).toBe(true);
			expect(second.lines.some((line) => line.includes("already at origin/dev"))).toBe(false);
			expect(calls).toContainEqual(["bun", "install"]);
			expect(calls).toContainEqual(["bun", "run", "build:senpi-plugin"]);
		} finally {
			restorePath();
		}
	});

	it("warns once and skips when the bun binary is missing", { timeout: 90000 }, async () => {
		const root = makeTempRoot();
		const fixture = createOmoFixture(root);
		const agentDir = makeAgentDir(root);
		const pluginBefore = snapshotDir(fixture.pluginPath);
		const noBun: OmoLocalRun = async (command, args, runOptions) => {
			if (command === "bun") {
				throw Object.assign(new Error("spawn bun ENOENT"), { code: "ENOENT" });
			}
			return defaultRun(command, args, runOptions);
		};
		const { lines, log } = makeLogCollector();
		await expect(
			runOmoLocalUpdateBeta({
				env: {},
				agentDir,
				settings: { packages: [fixture.pluginPath] },
				log,
				run: noBun,
			}),
		).resolves.toBeUndefined();
		expect(lines.filter((line) => line.includes("bun is required"))).toHaveLength(1);
		expect(lines.some((line) => line.includes("OMO local plugin update failed"))).toBe(false);
		expect(lines.some((line) => line.includes("Updated OMO local plugins"))).toBe(false);
		expect(readStamp(agentDir)).toBeUndefined();
		expect(snapshotDir(fixture.pluginPath)).toEqual(pluginBefore);
	});

	it("downgrades a fetch failure to a yellow warning and leaves the repo untouched", {
		timeout: 90000,
	}, async () => {
		const root = makeTempRoot();
		const fixture = createOmoFixture(root);
		const agentDir = makeAgentDir(root);
		git(["remote", "set-url", "origin", join(root, "does-not-exist.git")], fixture.repoRoot);
		const headBefore = headSha(fixture.repoRoot);
		const { lines, log } = makeLogCollector();
		await expect(
			runOmoLocalUpdateBeta({
				env: {},
				agentDir,
				settings: { packages: [fixture.pluginPath] },
				log,
				run: defaultRun,
			}),
		).resolves.toBeUndefined();
		expect(lines.some((line) => line.includes("OMO local plugin update failed (fetch):"))).toBe(true);
		expect(lines.some((line) => line.includes("To update manually:"))).toBe(true);
		expect(headSha(fixture.repoRoot)).toBe(headBefore);
		expect(git(["status", "--porcelain"], fixture.repoRoot)).toBe("");
		expect(readStamp(agentDir)).toBeUndefined();
		expect(existsSync(omoLocalUpdateLockPath(agentDir))).toBe(false);
		expect(existsSync(omoLocalUpdateBuildWorktreePath(agentDir))).toBe(false);
	});

	it("allows exactly one of two simultaneous runs to proceed", { timeout: 90000 }, async () => {
		const root = makeTempRoot();
		const fixture = createOmoFixture(root);
		const agentDir = makeAgentDir(root);
		const binDir = join(root, "bin");
		installFakeBun(binDir);
		const restorePath = withPrependedPath(binDir);
		const { lines, log } = makeLogCollector();
		const options = {
			env: {},
			agentDir,
			settings: { packages: [fixture.pluginPath] },
			log,
			run: defaultRun,
		};
		try {
			await expect(Promise.all([runOmoLocalUpdateBeta(options), runOmoLocalUpdateBeta(options)])).resolves.toEqual([
				undefined,
				undefined,
			]);
		} finally {
			restorePath();
		}
		expect(lines.filter((line) => line.includes("Updated OMO local plugins"))).toHaveLength(1);
		expect(lines.filter((line) => line.includes("already running (pid"))).toHaveLength(1);
		expect(readStamp(agentDir)).toBeDefined();
		expect(existsSync(omoLocalUpdateLockPath(agentDir))).toBe(false);
	});

	it("reclaims the lock from a dead pid and proceeds", { timeout: 90000 }, async () => {
		const root = makeTempRoot();
		const fixture = createOmoFixture(root);
		const agentDir = makeAgentDir(root);
		const binDir = join(root, "bin");
		installFakeBun(binDir);
		const restorePath = withPrependedPath(binDir);
		const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
		if (deadPid === undefined) throw new Error("expected a child pid");
		writeFileSync(
			omoLocalUpdateLockPath(agentDir),
			JSON.stringify({ pid: deadPid, nonce: "stale", startedAt: "2020-01-01T00:00:00.000Z" }),
		);
		const { lines, log } = makeLogCollector();
		try {
			await runOmoLocalUpdateBeta({
				env: {},
				agentDir,
				settings: { packages: [fixture.pluginPath] },
				log,
				run: defaultRun,
			});
		} finally {
			restorePath();
		}
		expect(lines.some((line) => line.includes("Updated OMO local plugins"))).toBe(true);
		expect(readStamp(agentDir)).toBeDefined();
		expect(existsSync(omoLocalUpdateLockPath(agentDir))).toBe(false);
	});

	it("never takes over a live pid's lock, regardless of age", { timeout: 90000 }, async () => {
		const root = makeTempRoot();
		const fixture = createOmoFixture(root);
		const agentDir = makeAgentDir(root);
		writeFileSync(
			omoLocalUpdateLockPath(agentDir),
			JSON.stringify({ pid: process.pid, nonce: "someone-else", startedAt: "2020-01-01T00:00:00.000Z" }),
		);
		const { calls, run } = makeSpyRun();
		const { lines, log } = makeLogCollector();
		await runOmoLocalUpdateBeta({
			env: {},
			agentDir,
			settings: { packages: [fixture.pluginPath] },
			log,
			run,
		});
		expect(lines.some((line) => line.includes(`already running (pid ${process.pid})`))).toBe(true);
		// No fetch, no worktree, no build - nothing but detection ran.
		expect(calls.some(([, ...args]) => args.includes("fetch"))).toBe(false);
		expect(calls.some(([, ...args]) => args.includes("worktree"))).toBe(false);
		expect(calls.some(([command]) => command === "bun")).toBe(false);
		expect(readStamp(agentDir)).toBeUndefined();
		expect(git(["status", "--porcelain"], fixture.repoRoot)).toBe("");
		expect(existsSync(omoLocalUpdateBuildWorktreePath(agentDir))).toBe(false);
		// The other owner's lock is left in place.
		expect(existsSync(omoLocalUpdateLockPath(agentDir))).toBe(true);
	});

	it("kill-switch run has zero fs/git side effects", { timeout: 90000 }, async () => {
		const root = makeTempRoot();
		const fixture = createOmoFixture(root);
		const agentDir = makeAgentDir(root);
		const headBefore = headSha(fixture.repoRoot);
		const { calls, run } = makeSpyRun();
		const { lines, log } = makeLogCollector();
		await runOmoLocalUpdateBeta({
			env: { SENPI_OMO_LOCAL_UPDATE: "0" },
			agentDir,
			settings: { packages: [fixture.pluginPath] },
			log,
			run,
		});
		expect(lines).toEqual([]);
		expect(calls).toEqual([]);
		expect(headSha(fixture.repoRoot)).toBe(headBefore);
		expect(git(["status", "--porcelain"], fixture.repoRoot)).toBe("");
		expect(readStamp(agentDir)).toBeUndefined();
		expect(existsSync(omoLocalUpdateLockPath(agentDir))).toBe(false);
		expect(existsSync(omoLocalUpdateBuildWorktreePath(agentDir))).toBe(false);
	});
});
