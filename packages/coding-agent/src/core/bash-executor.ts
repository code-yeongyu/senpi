/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripAnsi } from "../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../utils/shell.ts";
import type { BashOperations } from "./tools/bash.ts";
import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.ts";

// ============================================================================
// Types
// ============================================================================

export interface BashExecutorOptions {
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
}

export interface BashResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Process exit code (undefined if killed/cancelled) */
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Path to temp file containing full output (if output exceeded truncation threshold) */
	fullOutputPath?: string;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Execute a bash command using custom BashOperations.
 * Used for remote execution (SSH, containers, etc.).
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const outputChunks: string[] = [];
	let outputChunkStart = 0;
	let outputBytes = 0;
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;

	let tempFilePath: string | undefined;
	let tempFileStream: WriteStream | undefined;
	let tempFileError: Error | undefined;
	let tempFileErrorListener: ((error: Error) => void) | undefined;
	let totalBytes = 0;

	const compactOutputChunks = () => {
		if (outputChunkStart < 64) {
			return;
		}
		outputChunks.splice(0, outputChunkStart);
		outputChunkStart = 0;
	};

	const outputText = () => outputChunks.slice(outputChunkStart).join("");

	const ensureTempFile = () => {
		if (tempFilePath) {
			return;
		}
		const id = randomBytes(8).toString("hex");
		tempFilePath = join(tmpdir(), `pi-bash-${id}.log`);
		tempFileStream = createWriteStream(tempFilePath);
		tempFileErrorListener = (error) => {
			tempFileError ??= error;
		};
		tempFileStream.on("error", tempFileErrorListener);
		for (let i = outputChunkStart; i < outputChunks.length; i++) {
			const chunk = outputChunks[i];
			if (chunk !== undefined) {
				tempFileStream.write(chunk);
			}
		}
	};

	const closeTempFileStream = async () => {
		const stream = tempFileStream;
		tempFileStream = undefined;
		if (!stream) {
			return;
		}
		if (tempFileError) {
			if (tempFileErrorListener) stream.off("error", tempFileErrorListener);
			stream.destroy();
			throw tempFileError;
		}

		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const cleanup = () => {
				stream.off("error", onError);
				if (tempFileErrorListener) stream.off("error", tempFileErrorListener);
				stream.off("close", onClose);
			};
			const settle = (error?: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				if (error) reject(error);
				else resolve();
			};
			const onError = (error: Error) => {
				tempFileError ??= error;
			};
			const onClose = () => {
				settle(tempFileError);
			};
			stream.on("error", onError);
			stream.once("close", onClose);
			stream.end();
		});
	};

	const decoder = new TextDecoder();

	const onData = (data: Buffer) => {
		totalBytes += data.length;

		// Sanitize: strip ANSI, replace binary garbage, normalize newlines
		const text = sanitizeBinaryOutput(stripAnsi(decoder.decode(data, { stream: true }))).replace(/\r/g, "");

		// Start writing to temp file if exceeds threshold
		if (totalBytes > DEFAULT_MAX_BYTES) {
			ensureTempFile();
		}

		if (tempFileStream) {
			tempFileStream.write(text);
		}

		outputChunks.push(text);
		outputBytes += text.length;
		while (outputBytes > maxOutputBytes && outputChunkStart < outputChunks.length - 1) {
			const removed = outputChunks[outputChunkStart];
			if (removed === undefined) {
				break;
			}
			outputBytes -= removed.length;
			outputChunkStart++;
		}
		compactOutputChunks();

		// Stream to callback
		if (options?.onChunk) {
			options.onChunk(text);
		}
	};

	const finishDecoder = () => {
		const finalText = sanitizeBinaryOutput(stripAnsi(decoder.decode())).replace(/\r/g, "");
		if (finalText.length > 0) {
			onData(Buffer.from(finalText, "utf-8"));
		}
	};

	const prepareFinalOutput = async () => {
		try {
			finishDecoder();
			const fullOutput = outputText();
			const truncationResult = truncateTail(fullOutput);
			if (truncationResult.truncated) {
				ensureTempFile();
			}
			return { fullOutput, truncationResult };
		} catch (error) {
			try {
				await closeTempFileStream();
			} catch (closeError) {
				throw new AggregateError([error, closeError], "Bash output finalization and spill cleanup failed");
			}
			throw error;
		}
	};

	let result: Awaited<ReturnType<BashOperations["exec"]>>;
	try {
		result = await operations.exec(command, cwd, {
			onData,
			signal: options?.signal,
		});
	} catch (err) {
		// Check if it was an abort
		if (options?.signal?.aborted) {
			const { fullOutput, truncationResult } = await prepareFinalOutput();
			await closeTempFileStream();
			return {
				output: truncationResult.truncated ? truncationResult.content : fullOutput,
				exitCode: undefined,
				cancelled: true,
				truncated: truncationResult.truncated,
				fullOutputPath: tempFilePath,
			};
		}

		await closeTempFileStream();

		throw err;
	}

	const { fullOutput, truncationResult } = await prepareFinalOutput();
	await closeTempFileStream();
	const cancelled = options?.signal?.aborted ?? false;

	return {
		output: truncationResult.truncated ? truncationResult.content : fullOutput,
		exitCode: cancelled ? undefined : (result.exitCode ?? undefined),
		cancelled,
		truncated: truncationResult.truncated,
		fullOutputPath: tempFilePath,
	};
}
