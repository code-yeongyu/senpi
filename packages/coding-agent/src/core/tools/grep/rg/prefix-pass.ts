import { open } from "node:fs/promises";
import { GrepEngineError, type GrepEngineResult } from "../engine.ts";
import type { Candidate } from "./enumerate.ts";
import { SearchTimeout } from "./process.ts";

export const MAX_FILE_BYTES = 4_194_304;

/** Returns only complete lines, or undefined when the candidate must be skipped. */
export async function readSearchablePrefix(
	candidate: Candidate,
	result: GrepEngineResult,
	check: () => void,
): Promise<Buffer | undefined> {
	let prefix: Buffer;
	try {
		const file = await open(candidate.absolute, "r");
		try {
			const buffer = Buffer.alloc(MAX_FILE_BYTES);
			let length = 0;
			while (length < buffer.length) {
				check();
				const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
				if (bytesRead === 0) break;
				length += bytesRead;
			}
			prefix = buffer.subarray(0, length);
		} finally {
			await file.close();
		}
	} catch (error) {
		if (error instanceof SearchTimeout || error instanceof GrepEngineError) throw error;
		check();
		result.skippedOversized++;
		result.warnings.push({ path: candidate.display, code: "SKIPPED_OVERSIZED", message: String(error) });
		return undefined;
	}
	check();
	// Inspect the full prefix BEFORE dropping its incomplete trailing line.
	if (prefix.indexOf(0) !== -1) {
		result.skippedBinary++;
		return undefined;
	}
	const newline = prefix.lastIndexOf(10);
	if (newline === -1) {
		result.skippedOversized++;
		return undefined;
	}
	return prefix.subarray(0, newline + 1);
}
