import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.ts";

/**
 * Issue #756 - a cross-project `--session` resume must never open the fork
 * confirmation in a non-interactive run.
 *
 * `promptConfirm()` blocks on readline, so a run that reaches it without an
 * interactive session hangs (or silently answers "no" once stdin ends). Two
 * distinct shapes have to stay covered:
 *
 * 1. stdin is not a terminal at all - pipes, detached spawns, app-server children.
 * 2. stdin IS a terminal while the resolved application mode is non-interactive,
 *    which is the documented `senpi --session <id> -p "say ok"` one-shot. Gating
 *    on `process.stdin.isTTY` alone misses this second shape.
 *
 * Case 2 boots the real CLI entry with the two TTY flags the terminal itself
 * would set, because `resolveAppMode()` consumes exactly those booleans; a
 * spawned pty is not portable across the platforms this suite runs on.
 */

const cliPath = resolve(__dirname, "../../../src/cli.ts");
const cliMainPath = resolve(__dirname, "../../../src/cli-main.ts");
const rootTsconfigPath = resolve(__dirname, "../../../../..", "tsconfig.json");
const SESSION_ID = "0197f6e4-4cf9-7f44-a2d8-f8f7f49ee9d3";
const FORK_PROMPT = "Fork this session into current directory?";
const CROSS_PROJECT_NOTICE = "Session found in different project:";
const CHILD_TIMEOUT_MS = 15_000;
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

interface CliFixture {
	agentDir: string;
	projectDir: string;
	otherProjectDir: string;
	sessionDir: string;
}

interface CliResult {
	code: number | null;
	output: string;
	timedOut: boolean;
}

const tempDirs: string[] = [];
const liveChildren = new Set<ChildProcess>();

function killChild(child: ChildProcess): void {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	const pid = child.pid;
	if (pid === undefined) {
		return;
	}
	try {
		child.kill("SIGKILL");
	} catch {
		// Already gone.
	}
}

afterEach(() => {
	for (const child of liveChildren) {
		killChild(child);
	}
	liveChildren.clear();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createFixture(): CliFixture {
	// realpath: on macOS tmpdir() is a symlink (/var -> /private/var) while the
	// spawned CLI sees the physical path via process.cwd(). Session cwd filtering
	// compares paths textually, so the fixture must use physical paths.
	const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "pi-session-cross-project-")));
	tempDirs.push(tempRoot);
	const fixture: CliFixture = {
		agentDir: join(tempRoot, "agent"),
		projectDir: join(tempRoot, "project"),
		otherProjectDir: join(tempRoot, "other-project"),
		sessionDir: join(tempRoot, "sessions"),
	};
	for (const dir of [fixture.agentDir, fixture.projectDir, fixture.otherProjectDir, fixture.sessionDir]) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(
		join(fixture.sessionDir, `${SESSION_ID}.jsonl`),
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: SESSION_ID,
			timestamp: "2026-08-07T00:00:00.000Z",
			cwd: fixture.otherProjectDir,
		})}\n`,
	);
	return fixture;
}

function sessionArgs(fixture: CliFixture): string[] {
	return ["--session-dir", fixture.sessionDir, "--session", SESSION_ID, "-p", "hi"];
}

/** Boot the real CLI entry with the TTY flags an interactive terminal would set. */
function interactiveTtyArgs(fixture: CliFixture): string[] {
	const bootstrap = [
		"process.stdin.isTTY = true;",
		"process.stdout.isTTY = true;",
		`process.argv = [process.argv[0], ${JSON.stringify(cliMainPath)}, ...${JSON.stringify(sessionArgs(fixture))}];`,
		`await import(${JSON.stringify(pathToFileURL(cliMainPath).href)});`,
	].join("\n");
	return ["--input-type=module", "-e", bootstrap];
}

function stripAnsi(value: string): string {
	return value.replace(ANSI_PATTERN, "");
}

async function runCli(args: string[], fixture: CliFixture): Promise<CliResult> {
	const child = spawn(process.execPath, args, {
		cwd: fixture.projectDir,
		env: {
			...process.env,
			[ENV_AGENT_DIR]: fixture.agentDir,
			PI_OFFLINE: "1",
			TSX_TSCONFIG_PATH: rootTsconfigPath,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	liveChildren.add(child);

	let captured = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		captured += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		captured += chunk.toString();
	});

	let timedOut = false;
	// This regression pins a hang: without a bounded wait and an unconditional
	// kill the test itself would block on the very failure it guards.
	const timeout = setTimeout(() => {
		timedOut = true;
		killChild(child);
	}, CHILD_TIMEOUT_MS);

	try {
		const code = await new Promise<number | null>((resolveExit, rejectSpawn) => {
			child.on("error", rejectSpawn);
			child.on("close", (exitCode) => resolveExit(exitCode));
		});
		return { code, output: stripAnsi(captured), timedOut };
	} finally {
		clearTimeout(timeout);
		killChild(child);
		liveChildren.delete(child);
	}
}

describe("issue #756 cross-project --session resume", () => {
	it("fails fast with guidance when stdin is not a terminal", async () => {
		const fixture = createFixture();

		const result = await runCli([cliPath, ...sessionArgs(fixture)], fixture);

		expect(result.timedOut).toBe(false);
		expect(result.code).toBe(1);
		expect(result.output).toContain(CROSS_PROJECT_NOTICE);
		expect(result.output).toContain(`--fork '${SESSION_ID}'`);
		expect(result.output).not.toContain(FORK_PROMPT);
	});

	it("fails fast with guidance for -p even when stdin is a terminal", async () => {
		const fixture = createFixture();

		const result = await runCli(interactiveTtyArgs(fixture), fixture);

		expect(result.timedOut).toBe(false);
		expect(result.code).toBe(1);
		expect(result.output).toContain(CROSS_PROJECT_NOTICE);
		expect(result.output).toContain(`--fork '${SESSION_ID}'`);
		expect(result.output).not.toContain(FORK_PROMPT);
	});
});
