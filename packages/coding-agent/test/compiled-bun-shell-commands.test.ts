import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// omo#9362: inside a `bun build --compile` executable, Bun Shell ran `bun` as the executable itself
// when PATH had no Bun, so an agent's `bun test` booted a second agent and returned its reply as a
// passing exit-0 result. These tests drive a compiled stand-in for the engine with a PATH that has
// no Bun, the way a Finder-launched desktop app or a fresh standalone install runs.
const bunVersion = spawnSync("bun", ["--version"], { encoding: "utf8" });
const bunAvailable = bunVersion.status === 0 && process.platform !== "win32";
if (!bunAvailable) console.warn("[compiled-bun-shell] skipped: needs `bun` on PATH and a POSIX host");

const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const fixtureEntry = fileURLToPath(new URL("./fixtures/compiled-bun-shell.mjs", import.meta.url));
let root = "";
let engine = "";

interface ShellResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

function runInEngine(
	command: string,
	options: { cwd?: string; path?: string; agentDir?: string; shell?: "bun" | "sh" } = {},
): ShellResult {
	const agentDir = options.agentDir ?? join(root, "agent");
	const run = spawnSync(engine, [], {
		encoding: "utf8",
		timeout: 120_000,
		env: {
			HOME: join(root, "home"),
			TMPDIR: join(root, "tmp"),
			PATH: options.path ?? SYSTEM_PATH,
			SENPI_CODING_AGENT_DIR: agentDir,
			PI_CODING_AGENT_DIR: agentDir,
			FIXTURE_COMMAND: command,
			FIXTURE_CWD: options.cwd ?? root,
			FIXTURE_SHELL: options.shell ?? "bun",
		},
	});
	const line = run.stdout.trim().split("\n").at(-1) ?? "";
	if (!line.startsWith("{"))
		throw new Error(`engine printed no result (status ${run.status}):\n${run.stdout}\n${run.stderr}`);
	return JSON.parse(line) as ShellResult;
}

function project(name: string, files: Record<string, string>): string {
	const dir = join(root, name);
	for (const [file, content] of Object.entries(files)) {
		mkdirSync(join(dir, file, ".."), { recursive: true });
		writeFileSync(join(dir, file), content);
	}
	return dir;
}

beforeAll(() => {
	if (!bunAvailable) return;
	root = mkdtempSync(join(tmpdir(), "senpi-compiled-bun-shell-"));
	for (const dir of ["home", "tmp", "agent"]) mkdirSync(join(root, dir), { recursive: true });
	engine = join(root, "engine");
	const build = spawnSync("bun", ["build", "--compile", fixtureEntry, "--outfile", engine], { encoding: "utf8" });
	if (build.status !== 0) throw new Error(`bun build --compile failed:\n${build.stdout}\n${build.stderr}`);
}, 180_000);

afterAll(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!bunAvailable)("bun from an agent shell inside a compiled executable", () => {
	it("prints Bun's version instead of re-running the executable", () => {
		const result = runInEngine("bun --version");

		expect(result.stdout).not.toContain("ENGINE-ENTRY-RAN");
		expect(result.stdout.trim()).toBe(bunVersion.stdout.trim());
		expect(result.exitCode).toBe(0);
	});

	it("installs a project's dependencies and runs its passing tests", () => {
		const dir = project("passing", {
			"dep/package.json": JSON.stringify({ name: "local-dep", version: "1.0.0", main: "index.js" }),
			"dep/index.js": "module.exports = (a, b) => a + b;\n",
			"package.json": JSON.stringify({
				name: "passing",
				private: true,
				dependencies: { "local-dep": "file:./dep" },
			}),
			"sum.test.ts":
				'import { expect, test } from "bun:test";\nimport add from "local-dep";\ntest("adds", () => expect(add(2, 3)).toBe(5));\n',
		});

		const result = runInEngine("bun install && bun test 2>&1", { cwd: dir });

		expect(result.stdout).not.toContain("ENGINE-ENTRY-RAN");
		expect(result.stdout).toMatch(/\b1 pass\b/);
		expect(result.exitCode).toBe(0);
	});

	it("runs bunx as Bun's package runner", () => {
		const result = runInEngine("bunx --version");

		expect(result.stdout).not.toContain("ENGINE-ENTRY-RAN");
		expect(result.stdout.trim()).toBe(bunVersion.stdout.trim());
	});

	it("gives a bash-tool shell a working bun instead of command-not-found", () => {
		const result = runInEngine("bun --version", { shell: "sh" });

		expect(result.stdout.trim()).toBe(bunVersion.stdout.trim());
		expect(result.exitCode).toBe(0);
	});

	it("keeps a Bun the user has on PATH in front of the bundled one", () => {
		const userBin = join(root, "user-bin");
		mkdirSync(userBin, { recursive: true });
		writeFileSync(join(userBin, "bun"), "#!/bin/sh\necho user-bun-0.0.1\n");
		chmodSync(join(userBin, "bun"), 0o755);

		const result = runInEngine("bun --version", { path: `${userBin}:${SYSTEM_PATH}` });

		expect(result.stdout.trim()).toBe("user-bun-0.0.1");
	});

	it("reports a failing test suite as a failure", () => {
		const dir = project("failing", {
			"package.json": JSON.stringify({ name: "failing", private: true }),
			"broken.test.ts": 'import { expect, test } from "bun:test";\ntest("broken", () => expect(1).toBe(2));\n',
		});

		const result = runInEngine("bun test 2>&1", { cwd: dir });

		expect(result.stdout).not.toContain("ENGINE-ENTRY-RAN");
		expect(result.stdout).toMatch(/\b1 fail\b/);
		expect(result.exitCode).not.toBe(0);
	});

	it("fails an unknown bun command instead of answering it as the executable", () => {
		const result = runInEngine("bun no-such-script-9362 2>&1");

		expect(result.stdout).not.toContain("ENGINE-ENTRY-RAN");
		expect(result.exitCode).not.toBe(0);
	});

	it("still runs Bun when the agent directory cannot hold the bun commands", () => {
		const blocked = join(root, "agent-is-a-file");
		writeFileSync(blocked, "not a directory\n");

		const result = runInEngine("bun --version", { agentDir: blocked });

		expect(result.stdout).not.toContain("ENGINE-ENTRY-RAN");
		expect(result.stdout.trim()).toBe(bunVersion.stdout.trim());
	});
});
