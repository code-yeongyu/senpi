import { constants, type Stats } from "node:fs";
import { access, mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { MachineOpError } from "../errors.ts";
import { checkPath, gated, resolveOpPath } from "../policy/gate.ts";
import type {
	EditRequest,
	EditResult,
	EntryType,
	FileOps,
	GlobRequest,
	GlobResult,
	GrepRequest,
	GrepResult,
	ListRequest,
	ListResult,
	OpContext,
	ReadRequest,
	ReadResult,
	StatRequest,
	StatResult,
	WriteRequest,
	WriteResult,
} from "../types.ts";
import { type FdResolver, localGlob } from "./glob.ts";
import { localGrep } from "./grep.ts";
import { acquireFileMutationLock } from "./mutation-queue.ts";

const ACCESS_MODES = {
	read: constants.R_OK,
	write: constants.W_OK,
	readwrite: constants.R_OK | constants.W_OK,
} as const;

function entryType(info: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): EntryType {
	if (info.isFile()) return "file";
	if (info.isDirectory()) return "directory";
	if (info.isSymbolicLink()) return "symlink";
	return "other";
}

function readLimitError(path: string, size: number, limit: number): MachineOpError {
	return new MachineOpError("limit_exceeded", `${path} is ${size} bytes, above the ${limit}-byte read limit`);
}

function nonNegativeInteger(value: number | undefined, name: string): void {
	if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
		throw new MachineOpError("invalid_argument", `${name} must be a non-negative integer`);
	}
}

/** Per-canonical-path ordering for mutations, unless the caller already holds the slot. */
async function withPathLock<T>(path: string, ctx: OpContext, fn: () => Promise<T>): Promise<T> {
	if (ctx.pathLock === "caller") return fn();
	const release = await acquireFileMutationLock(path, ctx.signal);
	try {
		return await fn();
	} finally {
		release();
	}
}

async function readWithinLimit(path: string, limit: number): Promise<Buffer> {
	// An unbounded limit (the tool path) reads exactly as fs.readFile always has, with no extra stat.
	if (Number.isFinite(limit)) {
		const info = await stat(path);
		if (info.size > limit) throw readLimitError(path, info.size, limit);
	}
	return readFile(path);
}

async function readRange(path: string, req: ReadRequest, limit: number): Promise<ReadResult> {
	const handle = await open(path, "r");
	try {
		const info: Stats = await handle.stat();
		const offset = req.offset ?? 0;
		const available = Math.max(0, info.size - offset);
		if (req.limitBytes === undefined && available > limit) throw readLimitError(path, available, limit);
		const length = Math.min(available, req.limitBytes ?? available);
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, offset);
		return { path, bytes: buffer.subarray(0, bytesRead), size: info.size, offset };
	} finally {
		await handle.close();
	}
}

async function writeRange(path: string, req: WriteRequest): Promise<void> {
	const offset = req.offset as number;
	if (req.total !== undefined && req.total < offset + req.bytes.byteLength) {
		throw new MachineOpError("invalid_argument", "total must cover offset + bytes");
	}
	const handle = await open(path, constants.O_RDWR | constants.O_CREAT, 0o666);
	try {
		await handle.write(req.bytes, 0, req.bytes.byteLength, offset);
		if (req.total !== undefined) await handle.truncate(req.total);
	} finally {
		await handle.close();
	}
}

export function createLocalFileOps(options: { resolveFd?: FdResolver }): FileOps {
	return {
		async read(req: ReadRequest, ctx: OpContext): Promise<ReadResult> {
			const path = resolveOpPath(req.path, ctx);
			nonNegativeInteger(req.offset, "offset");
			nonNegativeInteger(req.limitBytes, "limitBytes");
			const limit = ctx.limits.readMaxBytes;
			if (req.limitBytes !== undefined && req.limitBytes > limit) {
				throw new MachineOpError(
					"limit_exceeded",
					`limitBytes ${req.limitBytes} is above the ${limit}-byte read limit`,
				);
			}
			await checkPath(path, "read", "files.read", ctx);
			return gated("files.read", req, ctx, async () => {
				if (req.offset !== undefined || req.limitBytes !== undefined) return readRange(path, req, limit);
				const bytes = await readWithinLimit(path, limit);
				return { path, bytes, size: bytes.byteLength, offset: 0 };
			});
		},

		async write(req: WriteRequest, ctx: OpContext): Promise<WriteResult> {
			const path = resolveOpPath(req.path, ctx);
			nonNegativeInteger(req.offset, "offset");
			nonNegativeInteger(req.total, "total");
			await checkPath(path, "write", "files.write", ctx);
			return withPathLock(path, ctx, () =>
				gated("files.write", req, ctx, async () => {
					if (req.createParentDirs) await mkdir(dirname(path), { recursive: true });
					if (req.offset === undefined) await writeFile(path, req.bytes);
					else await writeRange(path, req);
					return { path, writtenBytes: req.bytes.byteLength };
				}),
			);
		},

		async edit(req: EditRequest, ctx: OpContext): Promise<EditResult> {
			const path = resolveOpPath(req.path, ctx);
			if (req.exact.length === 0) throw new MachineOpError("invalid_pattern", "exact substring must not be empty");
			await checkPath(path, "write", "files.edit", ctx);
			return withPathLock(path, ctx, () =>
				gated("files.edit", req, ctx, async () => {
					const content = (await readWithinLimit(path, ctx.limits.readMaxBytes)).toString("utf8");
					const pieces = content.split(req.exact);
					if (pieces.length === 1) throw new MachineOpError("not_found", "exact substring was not found");
					const next = pieces.join(req.replacement);
					const bytes = Buffer.from(next, "utf8");
					await writeFile(path, bytes);
					return {
						path,
						content: next,
						replacements: pieces.length - 1,
						writeResult: { path, writtenBytes: bytes.byteLength },
					};
				}),
			);
		},

		async glob(req: GlobRequest, ctx: OpContext): Promise<GlobResult> {
			const cwd = resolveOpPath(req.cwd ?? ".", ctx);
			if (ctx.scope.root !== undefined && (isAbsolute(req.pattern) || req.pattern.split(/[\\/]/).includes(".."))) {
				throw new MachineOpError("policy_denied", "a glob pattern may not leave the scope root");
			}
			await checkPath(cwd, "enumerate", "files.glob", ctx);
			return gated("files.glob", req, ctx, () =>
				localGlob(req.pattern, cwd, req.limit, ctx.signal, options.resolveFd),
			);
		},

		async grep(req: GrepRequest, ctx: OpContext): Promise<GrepResult> {
			const path = resolveOpPath(req.path, ctx);
			await checkPath(path, "enumerate", "files.grep", ctx);
			return gated("files.grep", req, ctx, () =>
				localGrep(path, req.pattern, req.limit, ctx.limits.readMaxBytes, ctx.signal),
			);
		},

		async stat(req: StatRequest, ctx: OpContext): Promise<StatResult> {
			const path = resolveOpPath(req.path, ctx);
			await checkPath(path, "read", "files.stat", ctx);
			return gated("files.stat", req, ctx, async () => {
				if (req.access !== undefined) await access(path, ACCESS_MODES[req.access]);
				const info = await stat(path);
				return { path, type: entryType(info), size: info.size, mtimeMs: info.mtimeMs, mode: info.mode };
			});
		},

		async list(req: ListRequest, ctx: OpContext): Promise<ListResult> {
			const path = resolveOpPath(req.path, ctx);
			await checkPath(path, "enumerate", "files.list", ctx);
			return gated("files.list", req, ctx, async () => {
				const dirents = await readdir(path, { withFileTypes: true });
				return { path, entries: dirents.map((dirent) => ({ name: dirent.name, type: entryType(dirent) })) };
			});
		},
	};
}
