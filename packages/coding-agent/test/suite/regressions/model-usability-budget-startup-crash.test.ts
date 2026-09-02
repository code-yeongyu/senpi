import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import { assertWorkspaceBuildPrerequisite } from "../../support/workspace-build-prerequisite.ts";

assertWorkspaceBuildPrerequisite(import.meta.url);

/**
 * Regression: an unusable model budget at session-creation time must never
 * escape as an uncaught exception.
 *
 * `AgentSession.assertModelUsable` throws `ModelUsabilityBudgetError` when
 * the selected model's context window cannot hold the assembled session
 * budget (live context + system prompt + tool schemas + reserves + safety
 * margin) - the common trigger is resuming a large existing session with a
 * model whose context window is too small for it. Before this fix, nothing
 * between that throw site (`sdk.ts`, via `createAgentSessionRuntime` in
 * `main.ts`) and the top-level `await main()` call caught it, so the error
 * reached Node as an uncaught exception: a raw stack trace plus the
 * `Node.js vX.Y.Z` crash banner, and the process died before any surface
 * (TUI, RPC, print mode) could render a normal error state.
 */

const cliPath = resolve(__dirname, "../../../src/cli.ts");
const SESSION_ID = "0197f6e4-4cf9-7f44-a2d8-f8f7f49ee9d4";
const TINY_MODEL_CONTEXT_WINDOW = 16_000;
const CHILD_TIMEOUT_MS = 20_000;
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

interface CliFixture {
	agentDir: string;
	projectDir: string;
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
	if (child.exitCode !== null || child.signalCode !== null) return;
	const pid = child.pid;
	if (pid === undefined) return;
	try {
		child.kill("SIGKILL");
	} catch {
		// Already gone.
	}
}

afterEach(() => {
	for (const child of liveChildren) killChild(child);
	liveChildren.clear();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createFixture(): CliFixture {
	// realpath: on macOS tmpdir() is a symlink (/var -> /private/var) while the
	// spawned CLI sees the physical path via process.cwd(). Session cwd filtering
	// compares paths textually, so the fixture must use physical paths.
	const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "pi-model-usability-budget-crash-")));
	tempDirs.push(tempRoot);
	const fixture: CliFixture = {
		agentDir: join(tempRoot, "agent"),
		projectDir: join(tempRoot, "project"),
		sessionDir: join(tempRoot, "sessions"),
	};
	for (const dir of [fixture.agentDir, fixture.projectDir, fixture.sessionDir]) {
		mkdirSync(dir, { recursive: true });
	}

	// A custom provider whose only model has a context window far smaller than
	// what the fixture session below will require, so session creation rejects
	// the budget instead of silently accepting it.
	writeFileSync(
		join(fixture.agentDir, "models.json"),
		`${JSON.stringify({
			providers: {
				"faux-tiny": {
					baseUrl: "https://example.test/v1",
					api: "openai-completions",
					apiKey: "test-key",
					models: [{ id: "tiny-ctx", contextWindow: TINY_MODEL_CONTEXT_WINDOW, maxTokens: 4_000 }],
				},
			},
		})}\n`.replace("TINY_MODEL_CONTEXT_WINDOW", String(TINY_MODEL_CONTEXT_WINDOW)),
	);

	// A persisted session whose live context alone (~40k tokens of prior usage)
	// already exceeds the tiny model's 16k context window once the fixed system
	// prompt / tool schema / reserve overhead is added on top.
	const sessionLines = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: SESSION_ID,
			timestamp: "2026-08-07T00:00:00.000Z",
			cwd: fixture.projectDir,
		}),
		JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-08-07T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
		}),
		JSON.stringify({
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp: "2026-08-07T00:00:02.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "hi there" }],
				api: "openai-completions",
				provider: "faux-tiny",
				model: "tiny-ctx",
				stopReason: "stop",
				usage: {
					input: 40_000,
					output: 1_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 41_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 2,
			},
		}),
	];
	writeFileSync(join(fixture.sessionDir, `${SESSION_ID}.jsonl`), `${sessionLines.join("\n")}\n`);

	return fixture;
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

describe("model usability budget rejection at startup", () => {
	it("fails closed with the budget error message instead of an uncaught crash", async () => {
		const fixture = createFixture();

		const result = await runCli(
			[
				cliPath,
				"--session-dir",
				fixture.sessionDir,
				"--session",
				SESSION_ID,
				"--provider",
				"faux-tiny",
				"--model",
				"tiny-ctx",
				"-p",
				"continue",
			],
			fixture,
		);

		expect(result.timedOut).toBe(false);
		// The error is a clean, handled exit(1) - not the default 1 Node also uses
		// for an uncaught exception - so this alone would not distinguish the two;
		// the crash-signature assertions below are what pin the actual regression.
		expect(result.code).toBe(1);
		expect(result.output).toContain("cannot switch: target context window 16000 tokens");
		expect(result.output).toContain("Compact the session, then revalidate and retry the model switch.");
		// Before the fix, the error escaped as an uncaught exception: this asserts
		// none of that crash signature is present in the handled output.
		expect(result.output).not.toContain("Node.js v");
		expect(result.output).not.toContain("at AgentSession.assertModelUsable");
		expect(result.output).not.toContain("at createAgentSession");
	});
});
