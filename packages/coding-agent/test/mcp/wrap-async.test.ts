import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpLogger } from "../../src/core/extensions/builtin/mcp/log.ts";
import type { McpErrorLogger } from "../../src/core/extensions/builtin/mcp/wrap.ts";
import { safeInterval, safeOn, safeTimer, wrapAsync } from "../../src/core/extensions/builtin/mcp/wrap.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "../..");
const repoRoot = path.resolve(packageRoot, "../..");
const mcpSourceRoot = path.join(packageRoot, "src/core/extensions/builtin/mcp");
const tsxCli = path.join(repoRoot, "node_modules/tsx/dist/cli.mjs");
const tempDirs: string[] = [];

describe("mcp async wrappers", () => {
	afterEach(async () => {
		await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
		tempDirs.length = 0;
	});

	it("routes wrapAsync callback errors to logger and notify without rejecting", async () => {
		const logger = new MemoryLogger();
		const notifications: string[] = [];
		const wrapped = wrapAsync(
			"unit.wrap",
			async () => {
				throw new Error("wrapped boom");
			},
			{
				logger,
				notify: (message) => {
					notifications.push(message);
				},
			},
		);

		await wrapped();

		expect(logger.entries).toEqual([{ scope: "unit.wrap", message: "wrapped boom" }]);
		expect(notifications).toEqual(["MCP unit.wrap failed: wrapped boom"]);
	});

	it("records wrapped error messages through the production MCP logger", async () => {
		const logDir = await mkdtemp(path.join(tmpdir(), "senpi-mcp-prod-logger-"));
		tempDirs.push(logDir);
		const logger = createMcpLogger("prod-probe", { logDir });
		const wrapped = wrapAsync(
			"prod.scope",
			async () => {
				throw new Error("prod boom");
			},
			{ logger },
		);

		await wrapped();

		const ringText = logger.getRingBuffer().join("\n");
		const fileText = await readFile(logger.filePath, "utf8");
		expect(ringText).toContain("prod.scope");
		expect(ringText).toContain("prod boom");
		expect(fileText).toContain("prod.scope");
		expect(fileText).toContain("prod boom");
	});

	it("does not print raw secret-bearing errors when fallback logging handles logger failure", async () => {
		const originalSecret = "wrap-secret-original-123";
		const loggerSecret = "wrap-secret-logger-456";
		const stderrLines: string[] = [];
		const consoleError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			stderrLines.push(args.map(formatUnknownForTest).join(" "));
		});
		const logger: McpErrorLogger = {
			error() {
				throw new Error(`logger failed Authorization: Basic ${loggerSecret}`);
			},
		};
		const wrapped = wrapAsync(
			"fallback.secret",
			() => {
				throw {
					headers: { Authorization: `Bearer ${originalSecret}` },
					url: `https://example.test/mcp?api_key=${originalSecret}`,
				};
			},
			{ logger },
		);

		await wrapped();
		consoleError.mockRestore();

		const stderrText = stderrLines.join("\n");
		expect(stderrText).not.toContain(originalSecret);
		expect(stderrText).not.toContain(loggerSecret);
		expect(stderrText).toContain("MCP fallback.secret logger failed");
	});

	it("keeps a child process alive when a wrapped timer callback throws", async () => {
		const result = await runChildScript("wrapped-timer", [
			`import { safeTimer } from ${JSON.stringify(pathToFileURL(path.join(mcpSourceRoot, "wrap.ts")).href)};`,
			"const logs = [];",
			"const logger = { error(scope, data) {",
			"  const message = data && typeof data === 'object' && 'message' in data ? data.message : String(data);",
			"  logs.push(scope + ':' + message);",
			"} };",
			"safeTimer('child.timer', 0, () => { throw new Error('timer boom'); }, { logger });",
			"globalThis.setTimeout(() => {",
			"  console.log(JSON.stringify({ logs }));",
			"  process.exit(logs.length === 1 && logs[0] === 'child.timer:timer boom' ? 0 : 2);",
			"}, 40);",
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("child.timer:timer boom");
		expect(result.stderr).toBe("");
	});

	it("proves an unwrapped timer callback exits non-zero in the scratch failure probe", async () => {
		const result = await runChildScript("unwrapped-timer", [
			"globalThis.setTimeout(() => { throw new Error('unwrapped boom'); }, 0);",
			"globalThis.setTimeout(() => process.exit(0), 40);",
		]);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("unwrapped boom");
	});

	it("unrefs timers and intervals while still routing callback failures", () => {
		const logger = new MemoryLogger();
		const timer = safeTimer(
			"unit.timer",
			10,
			() => {
				throw new Error("timer boom");
			},
			{ logger },
		);
		const interval = safeInterval(
			"unit.interval",
			10,
			() => {
				throw new Error("interval boom");
			},
			{ logger },
		);

		expect(timer.hasRef()).toBe(false);
		expect(interval.hasRef()).toBe(false);
		clearTimeout(timer);
		clearInterval(interval);
	});

	it("wraps event emitter listeners and returns an unsubscribe function", async () => {
		const emitter = new EventEmitter();
		const logger = new MemoryLogger();
		const off = safeOn(
			emitter,
			"data",
			"unit.event",
			async (payload) => {
				expect(payload).toBe("payload");
				throw new Error("event boom");
			},
			{ logger },
		);

		emitter.emit("data", "payload");
		await Promise.resolve();
		off();
		emitter.emit("data", "ignored");

		expect(logger.entries).toEqual([{ scope: "unit.event", message: "event boom" }]);
		expect(emitter.listenerCount("data")).toBe(0);
	});
});

class MemoryLogger implements McpErrorLogger {
	readonly entries: Array<{ scope: string; message: string }> = [];

	error(scope: string, data?: unknown): void {
		let message = String(data);
		if (data instanceof Error) {
			message = data.message;
		} else if (typeof data === "object" && data !== null && "message" in data) {
			const maybeMessage = data.message;
			if (typeof maybeMessage === "string") message = maybeMessage;
		}
		this.entries.push({ scope, message });
	}
}

function formatUnknownForTest(value: unknown): string {
	if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

interface ChildResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

async function runChildScript(name: string, lines: string[]): Promise<ChildResult> {
	const dir = await mkdtemp(path.join(tmpdir(), `senpi-mcp-${name}-`));
	tempDirs.push(dir);
	const scriptPath = path.join(dir, `${name}.mjs`);
	await writeFile(scriptPath, `${lines.join("\n")}\n`, "utf8");

	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [tsxCli, scriptPath], {
			cwd: packageRoot,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
		child.on("error", reject);
		child.on("exit", (exitCode) => {
			resolve({
				exitCode,
				stdout: Buffer.concat(stdoutChunks).toString("utf8"),
				stderr: Buffer.concat(stderrChunks).toString("utf8"),
			});
		});
	});
}
