import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const fixturePath = fileURLToPath(new URL("../fixtures/fake-cursor-agent.mjs", import.meta.url));
const testDirectories: string[] = [];
const descendantPids = new Set<number>();

interface RunResult {
	status: number | null;
	stdout: string;
	stderr: string;
	dump: {
		argv: string[];
		env: Record<string, string>;
	};
	pidFile: string;
}

const allowedEnv = {
	HOME: "/tmp/fake-cursor-home",
	PATH: process.env.PATH ?? "",
	AGENT_CLI_CREDENTIAL_STORE: "file",
	TERM: "xterm-256color",
	LANG: "C.UTF-8",
	LC_ALL: "C.UTF-8",
	FORCE_COLOR: "0",
};

function runFixture(scenario: string, argv = ["-p", "hello", "--output-format", "stream-json"]): Promise<RunResult> {
	const directory = mkdtempSync(join(tmpdir(), "fake-cursor-agent-test-"));
	testDirectories.push(directory);
	const dumpPath = join(directory, "invocation.json");
	const pidFile = join(directory, "grandchild.pid");

	return new Promise((resolve, reject) => {
		const child = spawn(fixturePath, argv, {
			env: {
				...allowedEnv,
				FAKE_CURSOR_SCENARIO: scenario,
				FAKE_CURSOR_ARGV_DUMP: dumpPath,
				FAKE_CURSOR_GRANDCHILD_PID_FILE: pidFile,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (status) => {
			resolve({
				status,
				stdout,
				stderr,
				dump: JSON.parse(readFileSync(dumpPath, "utf8")),
				pidFile,
			});
		});
	});
}

function parseJsonLines(stdout: string): unknown[] {
	return stdout
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function eventSequence(events: unknown[]): string[] {
	return events.map((event) => {
		const value = event as { type: string; subtype?: string };
		return value.subtype ? `${value.type}/${value.subtype}` : value.type;
	});
}

afterEach(() => {
	for (const pid of descendantPids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// The descendant already exited.
		}
	}
	descendantPids.clear();
	for (const directory of testDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("fake cursor-agent fixture", () => {
	it("is executable", () => {
		if (process.platform !== "win32") {
			expect(statSync(fixturePath).mode & 0o111).not.toBe(0);
		}
	});

	it("emits the captured happy-path dialect and records argv plus the env allowlist", async () => {
		const argv = ["-p", "hello world", "--model", "composer-2.5-fast", "--output-format", "stream-json"];
		const result = await runFixture("happy", argv);
		const events = parseJsonLines(result.stdout) as Array<Record<string, unknown>>;

		expect(result.status).toBe(0);
		expect(eventSequence(events)).toEqual([
			"system/init",
			"thinking/delta",
			"thinking/completed",
			"assistant",
			"assistant",
			"assistant",
			"result/success",
		]);
		expect(events[0]).toMatchObject({ session_id: "fake-session-001", model: "Composer 2.5 Fast" });
		expect(events.at(-1)).toMatchObject({
			request_id: "fake-request-001",
			usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 0 },
		});
		expect(result.dump).toEqual({ argv, env: allowedEnv });
	});

	it.each([
		["tools", ["tool_call/started", "tool_call/completed"]],
		["rejected", ["tool_call/completed"]],
		["slow", ["system/init", "assistant", "assistant", "assistant", "result/success"]],
	] as const)("emits the expected %s event sequence", async (scenario, sequence) => {
		const result = await runFixture(scenario);
		const events = parseJsonLines(result.stdout) as Array<Record<string, any>>;

		expect(result.status).toBe(0);
		expect(eventSequence(events)).toEqual(sequence);
		if (scenario === "tools") {
			expect(events[1].tool_call.shellToolCall.result.success).toMatchObject({
				exitCode: 0,
				stdout: "tooltest-force-77\n",
				stderr: "",
				executionTime: 25,
			});
		}
		if (scenario === "rejected") {
			expect(events[0].tool_call.shellToolCall.result.rejected).toEqual({
				command: "echo tooltest-42",
				workingDirectory: "/tmp/fake-cursor-workspace",
				reason: "",
				isReadonly: false,
			});
		}
	});

	it.each([
		["rate_limit", /rate.?limit/i],
		["invalid_model", /Invalid model value: fake-invalid-model/],
		["keychain_locked", /Error: Your macOS login keychain is locked\./],
		["context_overflow", /context length|context window/i],
	] as const)("exits non-zero for %s and reports the failure on stderr", async (scenario, message) => {
		const result = await runFixture(scenario);

		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toMatch(message);
	});

	it("places a truncated JSON line and garbage among valid malformed-scenario events", async () => {
		const result = await runFixture("malformed");
		const lines = result.stdout.trim().split("\n");

		expect(result.status).toBe(0);
		expect(lines).toHaveLength(5);
		expect(() => JSON.parse(lines[0])).not.toThrow();
		expect(() => JSON.parse(lines[1])).toThrow();
		expect(() => JSON.parse(lines[2])).not.toThrow();
		expect(lines[3]).toBe("not-json-at-all");
		expect(() => JSON.parse(lines[4])).not.toThrow();
	});

	it("spawns a live descendant before emitting the happy sequence", async () => {
		const result = await runFixture("grandchild");
		const pid = Number(readFileSync(result.pidFile, "utf8"));
		descendantPids.add(pid);

		expect(result.status).toBe(0);
		expect(eventSequence(parseJsonLines(result.stdout))).toEqual([
			"system/init",
			"thinking/delta",
			"thinking/completed",
			"assistant",
			"assistant",
			"assistant",
			"result/success",
		]);
		expect(pid).toBeGreaterThan(0);
		expect(() => process.kill(pid, 0)).not.toThrow();
	});
});
