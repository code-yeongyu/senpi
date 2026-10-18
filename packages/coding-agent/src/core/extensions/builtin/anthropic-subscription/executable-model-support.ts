import { closeSync, openSync, readSync } from "node:fs";
import { claudeCodeExecutableCandidates, defaultExecutableDeps } from "./executable.ts";
import { bundledClaudeCodeVersion } from "./executable-version.ts";

/**
 * Minimum Claude Code versions the Anthropic API has been observed to demand for a model, taken
 * from its 400 "Claude Code X does not support this model; version Y or newer is required".
 * Append-only: record a floor only from such an observed rejection, never from a guess.
 */
export const OBSERVED_CLAUDE_CODE_MODEL_FLOORS: Readonly<Record<string, string>> = {
	"claude-fable-5-1": "2.1.251",
	"claude-opus-5-5": "2.1.280",
};

export type BundledClaudeCodeBinary = { path: string; claudeCodeVersion: string | undefined };

/** The platform binary the pinned SDK ships for this host - never a `claude` on PATH. */
export function bundledClaudeCodeBinary(): BundledClaudeCodeBinary | undefined {
	const deps = defaultExecutableDeps();
	const candidates = claudeCodeExecutableCandidates(
		deps.platform,
		deps.arch,
		deps.platform === "linux" && deps.isMusl?.() === true,
	);
	for (const candidate of candidates) {
		let path: string;
		try {
			path = deps.resolve(candidate);
		} catch {
			continue; // this platform package is not installed; try the next candidate
		}
		if (deps.isFile(path)) return { path, claudeCodeVersion: bundledClaudeCodeVersion() };
	}
	return undefined;
}

const CHUNK_BYTES = 8 * 1024 * 1024;
const ID_BYTE = /[A-Za-z0-9._-]/;

function isIdByte(byte: number | undefined): boolean {
	return byte !== undefined && ID_BYTE.test(String.fromCharCode(byte));
}

/** True when `needle` occurs in `chunk` as a whole token, so `claude-opus-5` never matches inside `claude-opus-5-5`. */
function containsToken(chunk: Buffer, needle: Buffer): boolean {
	for (let at = chunk.indexOf(needle); at !== -1; at = chunk.indexOf(needle, at + 1)) {
		if (!isIdByte(chunk[at - 1]) && !isIdByte(chunk[at + needle.length])) return true;
	}
	return false;
}

/**
 * Which of `tokens` the Claude Code binary at `path` embeds as plain text. The binary is a compiled
 * bundle whose model table is stored verbatim, so a model id it does not contain is one it predates.
 * Read in chunks that overlap by the longest token so a match across a chunk boundary is not lost.
 */
export function binaryEmbedsTokens(path: string, tokens: readonly string[]): Map<string, boolean> {
	const needles = tokens.map((token) => ({ token, bytes: Buffer.from(token) }));
	const found = new Map(tokens.map((token) => [token, false]));
	const overlap = Math.max(0, ...needles.map(({ bytes }) => bytes.length)) + 1;
	const buffer = Buffer.alloc(CHUNK_BYTES + overlap);
	const fd = openSync(path, "r");
	try {
		let carried = 0;
		let position = 0;
		for (;;) {
			const read = readSync(fd, buffer, carried, CHUNK_BYTES, position);
			if (read === 0) break;
			position += read;
			const chunk = buffer.subarray(0, carried + read);
			for (const { token, bytes } of needles) {
				if (!found.get(token) && containsToken(chunk, bytes)) found.set(token, true);
			}
			carried = Math.min(overlap, chunk.length);
			chunk.copy(buffer, 0, chunk.length - carried);
		}
	} finally {
		closeSync(fd);
	}
	return found;
}
