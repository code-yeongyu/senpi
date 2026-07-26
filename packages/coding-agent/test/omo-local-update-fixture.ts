/**
 * Fake omo repo factory for omo-local-update (v2) tests and QA.
 *
 * Builds a fully local git fixture (bare origin + clone) under a caller-provided
 * tmpDir: the clone carries a stub `build:senpi-plugin` script that writes the
 * FULL artifact completeness set, the three omo package manifests with their
 * real names, and seed source files - all committed on `dev` and pushed.
 *
 * The stub build is runnable BOTH via `bun run build:senpi-plugin` (through the
 * root package.json script) and directly via `node scripts/build-senpi-plugin.mjs`,
 * and writes every artifact relative to its CURRENT WORKING DIRECTORY, so the
 * same committed script produces the artifact set in ANY worktree it is run from
 * (the updater builds in its own persistent build worktree, never in the user's
 * checkout). The stub embeds the tracked `packages/omo-senpi/build-marker.txt`
 * content into `plugin/extensions/omo.js`, so a test can prove the installed
 * plugin was built from a SPECIFIC origin/dev commit.
 *
 * Determinism contract: no network, everything under the passed tmpDir, and
 * every git invocation runs with GIT_CONFIG_GLOBAL pointed at an empty file,
 * GIT_CONFIG_NOSYSTEM=1, and fixed GIT_AUTHOR_* / GIT_COMMITTER_* identity
 * and dates, so ambient host git config can never change an outcome.
 *
 * This is a non-test helper module: it stays dependency-free and must NOT
 * import src/beta/omo-local-update.ts.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface OmoFixture {
	/** Working clone of the fake omo repo (checked out on dev, tracking origin/dev). */
	repoRoot: string;
	/** Bare origin repository the clone pushes to and fetches from. */
	originDir: string;
	/** The local-path plugin dir a settings `packages` entry would point at. */
	pluginPath: string;
}

/** Artifact completeness set written by the stub build, relative to pluginPath. */
export const FIXTURE_PLUGIN_ARTIFACTS = [
	"extensions/omo.js",
	"runtime/lsp-daemon/dist/cli.js",
	"runtime/lsp-daemon/dist/index.js",
	"runtime/lsp-daemon/dist/.omo-runtime-manifest.json",
	"scripts/install.mjs",
	"skills/alpha/SKILL.md",
	"skills/beta/SKILL.md",
] as const;

const SOURCE_INDEX_TS = "packages/omo-senpi/src/index.ts";
const BUILD_MARKER = "packages/omo-senpi/build-marker.txt";
const SENPI_TASK_INDEX_TS = "packages/senpi-task/src/index.ts";

/**
 * Cwd-relative stub build: the updater runs `bun run build:senpi-plugin` with
 * cwd = the build worktree, so basing every path on process.cwd() makes the
 * same committed script correct in ANY worktree. The tracked build marker is
 * embedded into extensions/omo.js so tests can assert WHICH origin/dev commit
 * the installed plugin content was built from.
 */
const BUILD_SCRIPT = `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const repoRoot = process.cwd();
const pluginRoot = join(repoRoot, "packages", "omo-senpi", "plugin");
const markerPath = join(repoRoot, "packages", "omo-senpi", "build-marker.txt");
const marker = existsSync(markerPath) ? readFileSync(markerPath, "utf8").trim() : "none";
const artifacts = {
	"extensions/omo.js": "// omo extension bundle (fixture stub)\\n// marker: " + marker + "\\nexport {};\\n",
	"runtime/lsp-daemon/dist/cli.js": "// lsp daemon cli (fixture stub)\\n",
	"runtime/lsp-daemon/dist/index.js": "// lsp daemon index (fixture stub)\\n",
	"runtime/lsp-daemon/dist/.omo-runtime-manifest.json": JSON.stringify({ fixture: true, schema: 1 }) + "\\n",
	"scripts/install.mjs": "// install script (fixture stub)\\n",
	"skills/alpha/SKILL.md": "# alpha skill (fixture stub)\\n",
	"skills/beta/SKILL.md": "# beta skill (fixture stub)\\n",
};
for (const [relativePath, content] of Object.entries(artifacts)) {
	const target = join(pluginRoot, relativePath);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, content);
}
console.log("fixture build:senpi-plugin wrote " + Object.keys(artifacts).length + " artifacts (marker: " + marker + ")");
`;

function gitDirFor(anchorDir: string): string {
	const dotGit = join(anchorDir, ".git");
	return existsSync(dotGit) ? dotGit : anchorDir;
}

function ensureConfig(anchorDir: string): string {
	const configPath = join(gitDirFor(anchorDir), "fixture-gitconfig");
	if (!existsSync(configPath)) writeFileSync(configPath, "");
	return configPath;
}

function gitEnv(configPath: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		GIT_CONFIG_GLOBAL: configPath,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "OMO Fixture",
		GIT_AUTHOR_EMAIL: "omo-fixture@example.invalid",
		GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
		GIT_COMMITTER_NAME: "OMO Fixture",
		GIT_COMMITTER_EMAIL: "omo-fixture@example.invalid",
		GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
	};
}

/**
 * Environment for git invocations against a fixture repo, honoring the
 * determinism contract. `anchorDir` is a fixture repoRoot or originDir.
 * Exported so tests can run their own git assertions under the same isolation.
 */
export function fixtureGitEnv(anchorDir: string): NodeJS.ProcessEnv {
	return gitEnv(ensureConfig(anchorDir));
}

function runGit(args: string[], cwd: string, configPath: string): string {
	return execFileSync("git", args, {
		cwd,
		env: gitEnv(configPath),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function writeSeedFile(repoRoot: string, relativePath: string, content: string): void {
	const target = join(repoRoot, relativePath);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, content);
}

function writeSeedJson(repoRoot: string, relativePath: string, value: Record<string, unknown>): void {
	writeSeedFile(repoRoot, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Build the fake omo repo: bare origin + clone, stub build writing the full
 * artifact completeness set (cwd-relative, runnable via bun AND node), all
 * three omo package manifests, committed on `dev` and pushed, origin URL set
 * to the local bare path.
 */
export function createOmoFixture(tmpDir: string): OmoFixture {
	mkdirSync(tmpDir, { recursive: true });
	const originDir = join(tmpDir, "origin.git");
	const repoRoot = join(tmpDir, "repo");
	const pluginPath = join(repoRoot, "packages", "omo-senpi", "plugin");
	const configPath = join(tmpDir, "fixture-gitconfig");
	writeFileSync(configPath, "");

	runGit(["init", "--bare", "-b", "dev", originDir], tmpDir, configPath);
	runGit(["clone", originDir, repoRoot], tmpDir, configPath);
	runGit(["symbolic-ref", "HEAD", "refs/heads/dev"], repoRoot, configPath);

	writeSeedJson(repoRoot, "package.json", {
		name: "omo-fixture",
		private: true,
		version: "0.0.0",
		scripts: { "build:senpi-plugin": "node scripts/build-senpi-plugin.mjs" },
	});
	writeSeedFile(repoRoot, "scripts/build-senpi-plugin.mjs", BUILD_SCRIPT);
	writeSeedFile(repoRoot, ".gitignore", "node_modules/\n");
	writeSeedJson(repoRoot, "packages/omo-senpi/package.json", {
		name: "@oh-my-opencode/omo-senpi",
		private: true,
		version: "0.0.0",
	});
	writeSeedJson(repoRoot, "packages/omo-senpi/plugin/package.json", {
		name: "@code-yeongyu/omo-senpi",
		private: true,
		version: "0.0.0",
	});
	writeSeedJson(repoRoot, "packages/senpi-task/package.json", {
		name: "@oh-my-opencode/senpi-task",
		private: true,
		version: "0.0.0",
	});
	writeSeedFile(repoRoot, SOURCE_INDEX_TS, "// omo-senpi fixture source\nexport {};\n");
	writeSeedFile(repoRoot, SENPI_TASK_INDEX_TS, "// senpi-task fixture source\nexport {};\n");
	writeSeedFile(repoRoot, BUILD_MARKER, "marker-1\n");

	// Run the stub build once so the generated artifacts are TRACKED (matching
	// the real omo checkout, where plugin/extensions/omo.js etc. are committed).
	execFileSync(process.execPath, [join(repoRoot, "scripts", "build-senpi-plugin.mjs")], {
		cwd: repoRoot,
		stdio: ["ignore", "pipe", "pipe"],
	});

	runGit(["add", "-A"], repoRoot, configPath);
	runGit(["commit", "-m", "fixture: seed fake omo repo"], repoRoot, configPath);
	runGit(["push", "-u", "origin", "dev"], repoRoot, configPath);
	runGit(["remote", "set-url", "origin", originDir], repoRoot, configPath);

	return { repoRoot, originDir, pluginPath };
}

/** Modify a tracked SOURCE file (outside the plugin dir). Returns the relative path. */
export function dirtySource(repoRoot: string): string {
	appendFileSync(join(repoRoot, SOURCE_INDEX_TS), "// fixture source dirt\n");
	return SOURCE_INDEX_TS;
}

/** Create an UNTRACKED file outside the plugin dir. Returns the relative path. */
export function dirtyUntracked(repoRoot: string): string {
	const relativePath = "packages/omo-senpi/src/local-notes.txt";
	writeSeedFile(repoRoot, relativePath, "// untracked local notes (fixture)\n");
	return relativePath;
}

export type OmoAdvanceTouch = "omo-senpi" | "senpi-task" | "other";

/**
 * Advance origin/dev by committing in a second temporary clone of the bare
 * origin. `touch` selects WHERE the commit changes content:
 * - "omo-senpi": rewrites packages/omo-senpi/build-marker.txt (moves the
 *   omo-senpi tree AND the marker the stub build embeds into omo.js)
 * - "senpi-task": appends to packages/senpi-task/src/index.ts (moves only
 *   the senpi-task tree)
 * - "other": adds a root-level file (moves neither package tree)
 * Returns the new origin/dev sha. The fixture clone is NOT fetched.
 */
export function advanceOriginDev(options: { originDir: string; touch: OmoAdvanceTouch }): string {
	const { originDir, touch } = options;
	const configPath = ensureConfig(originDir);
	const n = Number(runGit(["rev-list", "--count", "dev"], originDir, configPath)) + 1;
	const workDir = join(dirname(originDir), "origin-advance-work");
	rmSync(workDir, { recursive: true, force: true });
	try {
		runGit(["clone", originDir, workDir], dirname(originDir), configPath);
		if (touch === "omo-senpi") {
			writeSeedFile(workDir, BUILD_MARKER, `marker-${n}\n`);
		} else if (touch === "senpi-task") {
			appendFileSync(join(workDir, SENPI_TASK_INDEX_TS), `// senpi-task change ${n}\n`);
		} else {
			writeSeedFile(workDir, `origin-dev-${n}.txt`, `origin dev commit ${n}\n`);
		}
		runGit(["add", "-A"], workDir, configPath);
		runGit(["commit", "-m", `origin dev commit ${n}`], workDir, configPath);
		runGit(["push", "origin", "dev"], workDir, configPath);
		return runGit(["rev-parse", "dev"], originDir, configPath);
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
}
