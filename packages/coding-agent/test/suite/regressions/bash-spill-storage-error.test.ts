// allow: SIZE_OK - one module-hoisted fs mock must own the complete spill lifecycle matrix.
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { Writable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spillState = vi.hoisted(() => {
	const createdStreams: Array<{ readonly destroyed: boolean }> = [];
	const artifactPaths: string[] = [];
	let emitQuotaError = true;
	let emitCloseError = false;
	let emitPrematureClose = false;
	let createArtifacts = false;
	const pendingCloseErrorEmissions: Array<() => void> = [];
	const pendingEmissions: Array<() => void> = [];
	const unhandledErrors: Error[] = [];
	const quotaError = Object.assign(new Error("unknown error, write"), {
		code: "EDQUOT",
		errno: -122,
		syscall: "write",
	});
	const closeError = Object.assign(new Error("input/output error, close"), {
		code: "EIO",
		errno: -5,
		syscall: "close",
	});
	let emitUnlinkError = false;
	const unlinkError = Object.assign(new Error("input/output error, unlink"), {
		code: "EIO",
		errno: -5,
		syscall: "unlink",
	});
	return {
		createdStreams,
		artifactPaths,
		closeError,
		unlinkError,
		get emitQuotaError() {
			return emitQuotaError;
		},
		set emitQuotaError(value: boolean) {
			emitQuotaError = value;
		},
		get emitCloseError() {
			return emitCloseError;
		},
		set emitCloseError(value: boolean) {
			emitCloseError = value;
		},
		get emitPrematureClose() {
			return emitPrematureClose;
		},
		set emitPrematureClose(value: boolean) {
			emitPrematureClose = value;
		},
		get createArtifacts() {
			return createArtifacts;
		},
		set createArtifacts(value: boolean) {
			createArtifacts = value;
		},
		get emitUnlinkError() {
			return emitUnlinkError;
		},
		set emitUnlinkError(value: boolean) {
			emitUnlinkError = value;
		},
		pendingCloseErrorEmissions,
		pendingEmissions,
		quotaError,
		unhandledErrors,
	};
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		createWriteStream: (path: string) => {
			if (spillState.createArtifacts) {
				writeFileSync(path, "");
				spillState.artifactPaths.push(path);
			}
			let emitted = false;
			const stream = new Writable({
				write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
					callback();
					if (emitted || !spillState.emitQuotaError) return;
					emitted = true;
					queueMicrotask(() => {
						for (const resolve of spillState.pendingEmissions.splice(0)) resolve();
						if (stream.listenerCount("error") === 0) {
							spillState.unhandledErrors.push(spillState.quotaError);
							return;
						}
						stream.emit("error", spillState.quotaError);
					});
				},
				destroy(_error: Error | null, callback: (error?: Error | null) => void) {
					if (!spillState.emitCloseError) {
						callback();
						return;
					}
					queueMicrotask(() => {
						for (const resolve of spillState.pendingCloseErrorEmissions.splice(0)) resolve();
						callback(spillState.closeError);
					});
				},
				final(callback: (error?: Error | null) => void) {
					if (spillState.emitPrematureClose) {
						stream.emit("close");
					}
					callback();
				},
			});
			spillState.createdStreams.push(stream);
			return stream;
		},
	};
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		rm: async (path: string, options: Parameters<typeof actual.rm>[1]) => {
			if (spillState.emitUnlinkError) {
				throw spillState.unlinkError;
			}
			return actual.rm(path, options);
		},
	};
});

import { executeBashWithOperations } from "../../../src/core/bash-executor.ts";
import type { BashOperations } from "../../../src/core/tools/bash.ts";
import { OutputAccumulator } from "../../../src/core/tools/output-accumulator.ts";
import { DEFAULT_MAX_BYTES } from "../../../src/core/tools/truncate.ts";

function nextSpillErrorEmission(): Promise<void> {
	return new Promise((resolve) => spillState.pendingEmissions.push(resolve));
}

describe("bash spill storage errors", () => {
	beforeEach(() => {
		for (const path of spillState.artifactPaths.splice(0)) {
			rmSync(path, { force: true });
		}
		spillState.createdStreams.length = 0;
		spillState.emitQuotaError = true;
		spillState.emitCloseError = false;
		spillState.emitPrematureClose = false;
		spillState.createArtifacts = false;
		spillState.emitUnlinkError = false;
		spillState.pendingEmissions.length = 0;
		spillState.pendingCloseErrorEmissions.length = 0;
		spillState.unhandledErrors.length = 0;
	});

	it("routes a quota failure through executeBashWithOperations instead of an unhandled stream error", async () => {
		const errorEmitted = nextSpillErrorEmission();
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.alloc(DEFAULT_MAX_BYTES + 1, "x"));
				await errorEmitted;
				return { exitCode: 0 };
			},
		};

		const execution = executeBashWithOperations("large output", process.cwd(), operations);

		await expect(execution).rejects.toBe(spillState.quotaError);
		expect(spillState.unhandledErrors).toEqual([]);
	});

	it("preserves a quota failure when cancellation races with command settlement", async () => {
		const errorEmitted = nextSpillErrorEmission();
		const controller = new AbortController();
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.alloc(DEFAULT_MAX_BYTES + 1, "x"));
				await errorEmitted;
				controller.abort();
				return { exitCode: 0 };
			},
		};

		const execution = executeBashWithOperations("cancelled large output", process.cwd(), operations, {
			signal: controller.signal,
		});

		await expect(execution).rejects.toBe(spillState.quotaError);
		expect(spillState.unhandledErrors).toEqual([]);
	});

	it("rejects when the bash spill file fails during terminal close after finish", async () => {
		spillState.emitQuotaError = false;
		spillState.emitCloseError = true;
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.alloc(DEFAULT_MAX_BYTES + 1, "x"));
				return { exitCode: 0 };
			},
		};

		const execution = executeBashWithOperations("late close failure", process.cwd(), operations);

		await expect(execution).rejects.toBe(spillState.closeError);
		expect(spillState.createdStreams).toHaveLength(1);
		expect(spillState.createdStreams[0]?.destroyed).toBe(true);
		expect(spillState.unhandledErrors).toEqual([]);
	});

	it("removes an executor spill artifact after a failed rejection", async () => {
		spillState.createArtifacts = true;
		const errorEmitted = nextSpillErrorEmission();
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.alloc(DEFAULT_MAX_BYTES + 1, "x"));
				await errorEmitted;
				return { exitCode: 0 };
			},
		};

		await expect(executeBashWithOperations("failed artifact", process.cwd(), operations)).rejects.toBe(
			spillState.quotaError,
		);
		expect(spillState.artifactPaths).toHaveLength(1);
		expect(existsSync(spillState.artifactPaths[0] ?? "")).toBe(false);
	});

	it("rejects when the accumulated-output spill file fails during terminal close after finish", async () => {
		spillState.emitQuotaError = false;
		spillState.emitCloseError = true;
		const output = new OutputAccumulator({ maxBytes: 1 });

		output.append(Buffer.from("too large"));

		await expect(output.closeTempFile()).rejects.toBe(spillState.closeError);
		expect(spillState.createdStreams).toHaveLength(1);
		expect(spillState.createdStreams[0]?.destroyed).toBe(true);
		expect(spillState.unhandledErrors).toEqual([]);
	});

	it("resolves each spill owner only after a normal terminal close", async () => {
		spillState.emitQuotaError = false;
		const executorOperations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.alloc(DEFAULT_MAX_BYTES + 1, "x"));
				return { exitCode: 0 };
			},
		};
		const executor = executeBashWithOperations("normal close", process.cwd(), executorOperations);
		const output = new OutputAccumulator({ maxBytes: 1 });
		output.append(Buffer.from("too large"));

		await expect(executor).resolves.toMatchObject({ truncated: true });
		await expect(output.closeTempFile()).resolves.toBeUndefined();
		expect(spillState.createdStreams).toHaveLength(2);
		expect(spillState.createdStreams.every((stream) => stream.destroyed)).toBe(true);
	});

	it("rejects each spill owner when close arrives before finish", async () => {
		spillState.emitQuotaError = false;
		spillState.emitPrematureClose = true;
		const executorOperations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.alloc(DEFAULT_MAX_BYTES + 1, "x"));
				return { exitCode: 0 };
			},
		};
		const executor = executeBashWithOperations("premature close", process.cwd(), executorOperations);
		const output = new OutputAccumulator({ maxBytes: 1 });
		output.append(Buffer.from("too large"));

		await expect(executor).rejects.toThrow("Bash spill stream closed before finish");
		await expect(output.closeTempFile()).rejects.toThrow("Output spill stream closed before finish");
		expect(spillState.createdStreams).toHaveLength(2);
		expect(spillState.createdStreams.every((stream) => stream.destroyed)).toBe(true);
	});

	it("preserves command and spill close failures in an AggregateError", async () => {
		spillState.emitQuotaError = false;
		spillState.emitCloseError = true;
		const commandError = new Error("command execution failed");
		const closeErrorEmitted = new Promise<void>((resolve) => spillState.pendingCloseErrorEmissions.push(resolve));
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.alloc(DEFAULT_MAX_BYTES + 1, "x"));
				throw commandError;
			},
		};

		const execution = executeBashWithOperations("command and close failure", process.cwd(), operations);
		let observedError: unknown;
		try {
			await execution;
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			observedError = error;
		}
		await closeErrorEmitted;

		expect(observedError).toBeInstanceOf(AggregateError);
		expect((observedError as AggregateError).errors).toEqual([commandError, spillState.closeError]);
	});

	it("closes the spill stream when decoder flush delivery throws", async () => {
		spillState.emitQuotaError = false;
		const callbackError = new Error("consumer failed on decoder flush");
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.alloc(DEFAULT_MAX_BYTES + 1, "x"));
				onData(Buffer.from([0xe2]));
				return { exitCode: 0 };
			},
		};

		const execution = executeBashWithOperations("partial utf8 output", process.cwd(), operations, {
			onChunk: (chunk) => {
				if (chunk === "\ufffd") throw callbackError;
			},
		});

		await expect(execution).rejects.toBe(callbackError);
		expect(spillState.createdStreams).toHaveLength(1);
		expect(spillState.createdStreams[0]?.destroyed).toBe(true);
	});

	it("preserves decoder callback and terminal close failures in order", async () => {
		spillState.emitQuotaError = false;
		spillState.emitCloseError = true;
		const callbackError = new Error("consumer failed on decoder flush");
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.alloc(DEFAULT_MAX_BYTES + 1, "x"));
				onData(Buffer.from([0xe2]));
				return { exitCode: 0 };
			},
		};

		let observedError: unknown;
		try {
			await executeBashWithOperations("callback and close failure", process.cwd(), operations, {
				onChunk: (chunk) => {
					if (chunk === "\ufffd") throw callbackError;
				},
			});
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			observedError = error;
		}

		expect(observedError).toBeInstanceOf(AggregateError);
		expect((observedError as AggregateError).errors).toEqual([callbackError, spillState.closeError]);
	});

	it("routes a quota failure through OutputAccumulator.closeTempFile", async () => {
		const errorEmitted = nextSpillErrorEmission();
		const output = new OutputAccumulator({ maxBytes: 1 });

		output.append(Buffer.from("too large"));
		await errorEmitted;

		await expect(output.closeTempFile()).rejects.toBe(spillState.quotaError);
		expect(spillState.unhandledErrors).toEqual([]);
	});

	it("removes an accumulator spill artifact after a failed close", async () => {
		spillState.createArtifacts = true;
		const errorEmitted = nextSpillErrorEmission();
		const output = new OutputAccumulator({ maxBytes: 1 });

		output.append(Buffer.from("too large"));
		await errorEmitted;
		await expect(output.closeTempFile()).rejects.toBe(spillState.quotaError);

		expect(spillState.artifactPaths).toHaveLength(1);
		expect(existsSync(spillState.artifactPaths[0] ?? "")).toBe(false);
	});

	it("aggregates an accumulator failure when artifact removal fails", async () => {
		spillState.createArtifacts = true;
		spillState.emitUnlinkError = true;
		const errorEmitted = nextSpillErrorEmission();
		const output = new OutputAccumulator({ maxBytes: 1 });

		output.append(Buffer.from("too large"));
		await errorEmitted;

		let observedError: unknown;
		try {
			await output.closeTempFile();
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			observedError = error;
		}

		expect(observedError).toBeInstanceOf(AggregateError);
		expect((observedError as AggregateError).errors).toEqual([spillState.quotaError, spillState.unlinkError]);
	});

	it("aggregates an executor callback failure when artifact removal fails", async () => {
		spillState.createArtifacts = true;
		spillState.emitQuotaError = false;
		spillState.emitUnlinkError = true;
		const callbackError = new Error("consumer failed");
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.alloc(DEFAULT_MAX_BYTES + 1, "x"));
				throw callbackError;
			},
		};

		let observedError: unknown;
		try {
			await executeBashWithOperations("callback cleanup failure", process.cwd(), operations);
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			observedError = error;
		}

		expect(observedError).toBeInstanceOf(AggregateError);
		expect((observedError as AggregateError).errors).toEqual([callbackError, spillState.unlinkError]);
	});
});
