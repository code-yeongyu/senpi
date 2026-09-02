import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import { assertWorkspaceBuildPrerequisite } from "../../support/workspace-build-prerequisite.ts";

assertWorkspaceBuildPrerequisite(import.meta.url);

const cliPath = resolve(__dirname, "../../../src/cli.ts");
const sessionId = "0197f6e4-4cf9-7f44-a2d8-f8f7f49ee9d4";
const childTimeoutMs = 20_000;
const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
const liveChildren = new Set<ChildProcess>();
const tempRoots: string[] = [];

interface CliFixture {
	agentDir: string;
	projectDir: string;
	sessionDir: string;
}

function createFixture(): CliFixture {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "senpi-startup-budget-")));
	tempRoots.push(root);
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	const sessionDir = join(root, "sessions");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });

	writeFileSync(
		join(agentDir, "models.json"),
		`${JSON.stringify({
			providers: {
				"faux-tiny": {
					baseUrl: "https://example.test/v1",
					api: "openai-completions",
					apiKey: "test-key",
					models: [{ id: "tiny-ctx", contextWindow: 16_000, maxTokens: 4_000 }],
				},
			},
		})}\n`,
	);
	writeFileSync(
		join(sessionDir, `${sessionId}.jsonl`),
		`${[
			{
				type: "session",
				version: 3,
				id: sessionId,
				timestamp: "2026-08-07T00:00:00.000Z",
				cwd: projectDir,
			},
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: "2026-08-07T00:00:01.000Z",
				message: {
					role: "user",
					content: [{ type: "text", text: "oversized restored context ".repeat(20_000) }],
					timestamp: Date.parse("2026-08-07T00:00:01.000Z"),
				},
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`,
	);
	return { agentDir, projectDir, sessionDir };
}

function killChild(child: ChildProcess): void {
	if (child.exitCode !== null || child.killed) return;
	child.kill("SIGKILL");
}

async function runCli(args: string[], fixture: CliFixture): Promise<{ code: number | null; output: string }> {
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
	let output = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	const timeout = setTimeout(() => killChild(child), childTimeoutMs);
	try {
		const code = await new Promise<number | null>((resolveExit, rejectSpawn) => {
			child.on("error", rejectSpawn);
			child.on("close", resolveExit);
		});
		return { code, output: output.replace(ansiPattern, "") };
	} finally {
		clearTimeout(timeout);
		killChild(child);
		liveChildren.delete(child);
	}
}

afterEach(() => {
	for (const child of liveChildren) killChild(child);
	liveChildren.clear();
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("model usability budget startup errors", () => {
	it("prints the actionable error without an uncaught stack when no recovery model is usable", async () => {
		const fixture = createFixture();

		const result = await runCli(
			[
				cliPath,
				"--session-dir",
				fixture.sessionDir,
				"--session",
				sessionId,
				"--provider",
				"faux-tiny",
				"--model",
				"tiny-ctx",
				"-p",
				"continue",
			],
			fixture,
		);

		expect(result.code).toBe(1);
		expect(result.output).toContain("cannot switch: target context window 16000 tokens");
		expect(result.output).toContain("Compact the session, then revalidate and retry the model switch.");
		expect(result.output).not.toContain("at AgentSession.assertModelUsable");
		expect(result.output).not.toContain("at createAgentSession");
		expect(result.output).not.toContain("Node.js v");
	});
});
