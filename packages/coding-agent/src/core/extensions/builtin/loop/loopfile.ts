import { createHash } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { CONFIG_DIR_NAME, resolveAgentDir } from "../../../../config.ts";
import type { LoopFileFingerprint as AnchoredLoopFileFingerprint } from "./types.ts";

/**
 * Content identity of the resolved loop file. `types.ts` owns the canonical, persisted
 * fingerprint; the resolver cannot know the delivery that anchors it, so it produces the
 * same shape minus that field and the tick builder anchors it at fire time.
 */
export type LoopFileFingerprint = Omit<AnchoredLoopFileFingerprint, "anchorDeliveryId">;

export interface LoopFileResolverDeps {
	readonly cwd: string;
	readonly homeDir: string;
	readonly fs: {
		stat(path: string): Promise<{ mtimeMs: number; size: number }>;
		readFile(path: string): Promise<Buffer>;
		readBytes(path: string, maxBytes: number): Promise<Buffer>;
	};
	readonly path: { join(...paths: string[]): string };
}

export type LoopFileResult =
	| { readonly found: false }
	| {
			readonly found: true;
			readonly path: string;
			readonly content: string;
			readonly fingerprint: LoopFileFingerprint;
	  };

export class LoopFileError extends Error {
	public readonly code: "stat_failed" | "read_failed";
	public readonly path: string;

	constructor(message: string, code: "stat_failed" | "read_failed", path: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "LoopFileError";
		this.code = code;
		this.path = path;
	}
}

const MAX_MODEL_BYTES = 25000;
const READ_LIMIT = MAX_MODEL_BYTES + 1;
const TRUNCATION_WARNING = "[loop.md truncated to the first 25000 bytes]";

function isEnoentError(err: unknown): boolean {
	return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT";
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function safeUtf8Truncate(buf: Buffer, maxBytes: number): string {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let slice = buf.subarray(0, maxBytes);
	while (slice.length > 0) {
		try {
			return decoder.decode(slice);
		} catch {
			slice = slice.subarray(0, slice.length - 1);
		}
	}
	return "";
}

type TryResolveOutcome =
	| {
			readonly found: true;
			readonly path: string;
			readonly content: string;
			readonly fingerprint: LoopFileFingerprint;
	  }
	| { readonly found: false }
	| { readonly error: LoopFileError };

async function tryResolveOne(path: string, fs: LoopFileResolverDeps["fs"]): Promise<TryResolveOutcome> {
	let stat: { mtimeMs: number; size: number };
	try {
		stat = await fs.stat(path);
	} catch (err) {
		if (isEnoentError(err)) return { found: false };
		return {
			error: new LoopFileError(`Failed to stat loop file ${path}`, "stat_failed", path, { cause: err }),
		};
	}

	let raw: Buffer;
	try {
		raw = await fs.readBytes(path, READ_LIMIT);
	} catch (err) {
		if (isEnoentError(err)) return { found: false };
		return {
			error: new LoopFileError(`Failed to read loop file ${path}`, "read_failed", path, { cause: err }),
		};
	}

	const truncated = raw.length > MAX_MODEL_BYTES;
	const modelVisible = truncated
		? `${safeUtf8Truncate(raw, MAX_MODEL_BYTES)}\n${TRUNCATION_WARNING}`
		: raw.toString("utf-8");

	return {
		found: true,
		path,
		content: modelVisible,
		fingerprint: {
			path,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			contentHash: sha256(modelVisible),
		},
	};
}

export async function resolveLoopFile(deps: LoopFileResolverDeps): Promise<LoopFileResult> {
	const { cwd, homeDir, fs, path } = deps;
	const candidates = [path.join(cwd, CONFIG_DIR_NAME, "loop.md"), path.join(resolveAgentDir(cwd, homeDir), "loop.md")];

	for (const candidate of candidates) {
		const outcome = await tryResolveOne(candidate, fs);
		if ("error" in outcome) {
			throw outcome.error;
		}
		if (outcome.found) {
			return outcome;
		}
	}

	return { found: false };
}

export const nodeFs: LoopFileResolverDeps["fs"] = {
	stat: (path) => fsPromises.stat(path),
	readFile: (path) => fsPromises.readFile(path),
	readBytes: async (path, maxBytes) => {
		const handle = await fsPromises.open(path, "r");
		try {
			const buf = Buffer.alloc(maxBytes);
			const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
			return buf.subarray(0, bytesRead);
		} finally {
			await handle.close();
		}
	},
};
