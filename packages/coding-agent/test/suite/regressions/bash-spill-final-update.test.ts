// allow: SIZE_OK - one module-hoisted fs mock keeps final-update, timer, command, and artifact cases isolated.
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spillState = vi.hoisted(() => ({
	createdStreams: [] as Writable[],
	tempFilePaths: [] as string[],
	emitCloseError: false,
	closeError: Object.assign(new Error("input/output error, close"), {
		code: "EIO",
		errno: -5,
		syscall: "close",
	}),
	rmCalls: 0,
	rmFailNext: false,
}));

vi.mock("node:fs/promises", () => ({
	rm: async (path: string) => {
		spillState.rmCalls++;
		if (spillState.rmFailNext) {
			spillState.rmFailNext = false;
			throw new Error(`unlink failed for ${path}`);
		}
		rmSync(path, { force: true });
	},
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		createWriteStream: (path: string) => {
			const stream = new Writable({
				write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
					appendFileSync(path, chunk);
					callback();
				},
				destroy(_error: Error | null, callback: (error?: Error | null) => void) {
					if (!spillState.emitCloseError) {
						callback();
						return;
					}
					queueMicrotask(() => callback(spillState.closeError));
				},
			});
			spillState.createdStreams.push(stream);
			spillState.tempFilePaths.push(path);
			return stream;
		},
	};
});

import { type BashOperations, createBashTool } from "../../../src/core/tools/bash.ts";
import { DEFAULT_MAX_BYTES } from "../../../src/core/tools/truncate.ts";

describe("bash spill final updates", () => {
	beforeEach(() => {
		spillState.createdStreams.length = 0;
		spillState.tempFilePaths.length = 0;
		spillState.emitCloseError = false;
		spillState.rmCalls = 0;
		spillState.rmFailNext = false;
		vi.useFakeTimers();
		vi.setSystemTime(1000);
	});

	it("closes the spill stream when the final onUpdate callback throws", async () => {
		const testDir = mkdtempSync(join(tmpdir(), "bash-spill-final-update-"));
		try {
			vi.stubEnv("TMPDIR", testDir);
			const callbackError = new Error("final update failed");
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.alloc(DEFAULT_MAX_BYTES + 1, "x"));
					vi.setSystemTime(1050);
					onData(Buffer.from("tail"));
					return { exitCode: 0 };
				},
			};
			let updateCount = 0;
			const bash = createBashTool(testDir, { operations });

			const execution = bash.execute("final-update-failure", { command: "chatty" }, undefined, () => {
				updateCount++;
				if (updateCount === 3) {
					throw callbackError;
				}
			});

			await expect(execution).rejects.toBe(callbackError);
			expect(updateCount).toBe(3);
			expect(spillState.createdStreams).toHaveLength(1);
			expect(spillState.createdStreams[0]?.destroyed).toBe(true);
			expect(spillState.tempFilePaths).toHaveLength(1);
			expect(existsSync(spillState.tempFilePaths[0] ?? "")).toBe(false);
		} finally {
			vi.unstubAllEnvs();
			vi.useRealTimers();
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("preserves final onUpdate and terminal close failures", async () => {
		const testDir = mkdtempSync(join(tmpdir(), "bash-spill-final-close-"));
		try {
			vi.stubEnv("TMPDIR", testDir);
			spillState.emitCloseError = true;
			const finalError = new Error("final update failed");
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.alloc(DEFAULT_MAX_BYTES + 1, "x"));
					vi.setSystemTime(1050);
					onData(Buffer.from("tail"));
					return { exitCode: 0 };
				},
			};
			let updateCount = 0;
			const bash = createBashTool(testDir, { operations });
			const execution = bash.execute("final-update-close-failure", { command: "chatty" }, undefined, () => {
				updateCount++;
				if (updateCount === 3) {
					throw finalError;
				}
			});

			let observedError: unknown;
			try {
				await execution;
			} catch (error) {
				if (!(error instanceof Error)) throw error;
				observedError = error;
			}

			expect(observedError).toBeInstanceOf(AggregateError);
			expect((observedError as AggregateError).errors).toEqual([finalError, spillState.closeError]);
			expect(spillState.createdStreams[0]?.destroyed).toBe(true);
		} finally {
			vi.unstubAllEnvs();
			vi.useRealTimers();
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("surfaces a trailing timer callback failure after closing the spill", async () => {
		const testDir = mkdtempSync(join(tmpdir(), "bash-spill-timer-update-"));
		try {
			vi.stubEnv("TMPDIR", testDir);
			const timerError = new Error("timer update failed");
			let releaseExecution: (() => void) | undefined;
			const timerReady = new Promise<void>((resolve) => {
				releaseExecution = resolve;
			});
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.alloc(DEFAULT_MAX_BYTES + 1, "x"));
					vi.setSystemTime(1050);
					onData(Buffer.from("tail"));
					await timerReady;
					return { exitCode: 0 };
				},
			};
			let updateCount = 0;
			const bash = createBashTool(testDir, { operations });
			const execution = bash.execute("timer-update-failure", { command: "chatty" }, undefined, () => {
				updateCount++;
				if (updateCount === 3) {
					throw timerError;
				}
			});

			vi.setSystemTime(1100);
			vi.runOnlyPendingTimers();
			releaseExecution?.();

			await expect(execution).rejects.toBe(timerError);
			expect(updateCount).toBe(3);
			expect(spillState.createdStreams[0]?.destroyed).toBe(true);
		} finally {
			vi.unstubAllEnvs();
			vi.useRealTimers();
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("cleans up a spill when the command rejects a string", async () => {
		const testDir = mkdtempSync(join(tmpdir(), "bash-spill-string-command-"));
		try {
			vi.stubEnv("TMPDIR", testDir);
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.alloc(DEFAULT_MAX_BYTES + 1, "x"));
					throw "command failed";
				},
			};
			const bash = createBashTool(testDir, { operations });

			await expect(bash.execute("string-command-failure", { command: "chatty" })).rejects.toBe("command failed");
			expect(spillState.createdStreams[0]?.destroyed).toBe(true);
			expect(existsSync(spillState.tempFilePaths[0] ?? "")).toBe(false);
		} finally {
			vi.unstubAllEnvs();
			vi.useRealTimers();
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("cleans up a spill when the final update rejects a cross-realm error", async () => {
		const testDir = mkdtempSync(join(tmpdir(), "bash-spill-cross-realm-update-"));
		try {
			vi.stubEnv("TMPDIR", testDir);
			const callbackError = runInNewContext("new Error('cross-realm update failed')");
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.alloc(DEFAULT_MAX_BYTES + 1, "x"));
					return { exitCode: 0 };
				},
			};
			const bash = createBashTool(testDir, { operations });
			let updateCount = 0;

			await expect(
				bash.execute("cross-realm-update-failure", { command: "chatty" }, undefined, () => {
					updateCount++;
					if (updateCount === 2) throw callbackError;
				}),
			).rejects.toBe(callbackError);
			expect(spillState.createdStreams[0]?.destroyed).toBe(true);
			expect(existsSync(spillState.tempFilePaths[0] ?? "")).toBe(false);
		} finally {
			vi.unstubAllEnvs();
			vi.useRealTimers();
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("retains an accumulator spill path after a failed removal for retry", async () => {
		const testDir = mkdtempSync(join(tmpdir(), "bash-spill-remove-retry-"));
		try {
			vi.stubEnv("TMPDIR", testDir);
			const { OutputAccumulator } = await import("../../../src/core/tools/output-accumulator.ts");
			const output = new OutputAccumulator({ maxBytes: 1, tempFilePrefix: "retry" });
			spillState.rmFailNext = true;
			output.appendText("spill");
			const spillPath = output.snapshot().fullOutputPath;
			expect(spillPath).toBeDefined();

			await expect(output.removeTempFile()).rejects.toThrow("unlink failed");
			expect(output.snapshot().fullOutputPath).toBe(spillPath);
			expect(existsSync(spillPath ?? "")).toBe(true);
			await output.removeTempFile();
			expect(existsSync(spillPath ?? "")).toBe(false);
		} finally {
			vi.unstubAllEnvs();
			vi.useRealTimers();
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("removes an accumulator spill after a command failure with successful finalization", async () => {
		const testDir = mkdtempSync(join(tmpdir(), "bash-spill-command-failure-"));
		try {
			vi.stubEnv("TMPDIR", testDir);
			const commandError = new Error("command execution failed");
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.alloc(DEFAULT_MAX_BYTES + 1, "x"));
					throw commandError;
				},
			};
			const bash = createBashTool(testDir, { operations });

			await expect(bash.execute("command-failure", { command: "chatty" })).rejects.toBe(commandError);
			expect(spillState.tempFilePaths).toHaveLength(1);
			expect(existsSync(spillState.tempFilePaths[0] ?? "")).toBe(false);
		} finally {
			vi.unstubAllEnvs();
			vi.useRealTimers();
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("preserves command and terminal close failures in the shell tool", async () => {
		const testDir = mkdtempSync(join(tmpdir(), "bash-spill-command-close-"));
		try {
			vi.stubEnv("TMPDIR", testDir);
			spillState.emitCloseError = true;
			const commandError = new Error("command execution failed");
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.alloc(DEFAULT_MAX_BYTES + 1, "x"));
					throw commandError;
				},
			};
			const bash = createBashTool(testDir, { operations });

			let observedError: unknown;
			try {
				await bash.execute("command-close-failure", { command: "chatty" });
			} catch (error) {
				if (!(error instanceof Error)) throw error;
				observedError = error;
			}

			expect(observedError).toBeInstanceOf(AggregateError);
			expect((observedError as AggregateError).errors).toEqual([commandError, spillState.closeError]);
			expect(spillState.createdStreams[0]?.destroyed).toBe(true);
		} finally {
			vi.unstubAllEnvs();
			vi.useRealTimers();
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("retains a readable full-output path after successful truncation", async () => {
		const testDir = mkdtempSync(join(tmpdir(), "bash-spill-success-"));
		try {
			vi.stubEnv("TMPDIR", testDir);
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.alloc(DEFAULT_MAX_BYTES + 1, "x"));
					onData(Buffer.from("TAIL-MARKER"));
					return { exitCode: 0 };
				},
			};
			const bash = createBashTool(testDir, { operations });

			const result = await bash.execute("successful-truncation", { command: "chatty" });
			const fullOutputPath = result.details?.fullOutputPath;

			expect(result.details?.truncation?.truncated).toBe(true);
			expect(fullOutputPath).toBeDefined();
			expect(existsSync(fullOutputPath ?? "")).toBe(true);
			const fullOutput = readFileSync(fullOutputPath ?? "", "utf8");
			expect(fullOutput.startsWith("x")).toBe(true);
			expect(fullOutput.endsWith("TAIL-MARKER")).toBe(true);
		} finally {
			vi.unstubAllEnvs();
			vi.useRealTimers();
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("returns no spill path for small output", async () => {
		const testDir = mkdtempSync(join(tmpdir(), "bash-spill-small-"));
		try {
			vi.stubEnv("TMPDIR", testDir);
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from("small"));
					return { exitCode: 0 };
				},
			};
			const bash = createBashTool(testDir, { operations });

			const result = await bash.execute("small-output", { command: "small" });

			expect(result.details).toBeUndefined();
			expect(spillState.tempFilePaths).toEqual([]);
		} finally {
			vi.unstubAllEnvs();
			vi.useRealTimers();
			rmSync(testDir, { recursive: true, force: true });
		}
	});
});
