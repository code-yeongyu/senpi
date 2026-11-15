/**
 * The run step of the relay host's file, shell, process and mesh ops (its `core-ops.ts`, ported), each on the shared
 * machine-ops layer with the op's OpContext. Every response carries exactly the relay host's fields; byte payloads are
 * base64 (`response.bytes`), the JSON form of the relay host's CBOR byte string.
 */
import {
	type EditRequest,
	type ExecRequest,
	type ExecResult,
	type GlobRequest,
	type GrepRequest,
	type ListRequest,
	MachineOpError,
	type MachineOps,
	type OpContext,
	type ReadRequest,
	type StatRequest,
	type WriteRequest,
} from "@code-yeongyu/senpi-machine-ops";
import { spawnPathIn } from "./real-path.ts";
import type { OpOutcome } from "./wire.ts";

export interface CoreCall {
	readonly ctx: OpContext;
	readonly ops: MachineOps;
	readonly root: string;
	readonly confined: boolean;
	/** The relay host's `env_overlay`, laid last over a child's environment. */
	readonly envOverlay: Readonly<Record<string, string>>;
}

const utf8 = new TextDecoder();
const applied = (response: Readonly<Record<string, unknown>>): OpOutcome => ({ state: "applied", response });
const shellOutcome = (r: ExecResult): OpOutcome => {
	if (r.aborted) return { state: "cancelled", error: { code: "aborted", message: "the op was cancelled" } };
	if (r.timedOut)
		return { state: "timed_out", error: { code: "timed_out", message: `timed out after ${r.durationMs} ms` } };
	return applied({
		exitCode: r.exitCode,
		signal: r.signal,
		stdout: utf8.decode(r.stdout),
		stderr: utf8.decode(r.stderr),
		timedOut: false,
		durationMs: r.durationMs,
		truncated: r.stdoutTruncated || r.stderrTruncated,
	});
};

// A read above the limit names the chunked form that reads it, first, so the message cap never cuts it.
const chunkedReadHint = (error: unknown, limit: number): unknown =>
	error instanceof MachineOpError && error.code === "limit_exceeded"
		? new MachineOpError(
				"limit_exceeded",
				`read it in chunks: fs.read {path, offset, limit_bytes} with limit_bytes at most ${limit} (${error.message})`,
			)
		: error;
export const runRead = async (req: ReadRequest, c: CoreCall): Promise<OpOutcome> => {
	const r = await c.ops.files.read(req, c.ctx).catch((error: unknown) => {
		throw chunkedReadHint(error, c.ctx.limits.readMaxBytes);
	});
	return applied({ path: r.path, bytes: Buffer.from(r.bytes).toString("base64"), size: r.size, offset: r.offset });
};
export const runWrite = async (req: WriteRequest, c: CoreCall): Promise<OpOutcome> => {
	const r = await c.ops.files.write(req, c.ctx);
	return applied({ path: r.path, writtenBytes: r.writtenBytes });
};
export const runEdit = async (req: EditRequest, c: CoreCall): Promise<OpOutcome> => {
	const r = await c.ops.files.edit(req, c.ctx);
	return applied({ path: r.path, replacements: r.replacements, writtenBytes: r.writeResult.writtenBytes });
};
export const runGlob = async (req: GlobRequest, c: CoreCall): Promise<OpOutcome> => {
	const r = await c.ops.files.glob(req, c.ctx);
	return applied({ entries: r.entries.map((e) => e.path), truncated: r.truncated });
};
export const runGrep = async (req: GrepRequest, c: CoreCall): Promise<OpOutcome> => {
	const r = await c.ops.files.grep(req, c.ctx);
	return applied({ matches: r.matches.map((m) => ({ ...m })), truncated: r.truncated });
};
export const runStat = async (req: StatRequest, c: CoreCall): Promise<OpOutcome> => {
	const r = await c.ops.files.stat(req, c.ctx);
	return applied({ path: r.path, type: r.type, size: r.size, mtimeMs: Math.floor(r.mtimeMs), mode: r.mode });
};
export const runList = async (req: ListRequest, c: CoreCall): Promise<OpOutcome> => {
	const r = await c.ops.files.list(req, c.ctx);
	return applied({ path: r.path, entries: r.entries.map((e) => ({ ...e })) });
};
// A shell runs in the scope root, or where its cwd really resolves under it; never in the engine's own working
// directory (review L2: the relay host ran a cwd-less shell in its own).
export const runShell = async (req: ExecRequest, c: CoreCall): Promise<OpOutcome> => {
	const cwd = req.cwd === undefined ? c.root : await spawnPathIn(c.root, req.cwd, c.confined);
	return shellOutcome(await c.ops.process.exec({ ...req, cwd, env: { ...req.env, ...c.envOverlay } }, c.ctx));
};

const processNotFound = (message: string): OpOutcome => ({
	state: "failed",
	error: { code: "process_not_found", message },
});
// A handleId names a terminal the engine runs (`pidOfHandle`); a missing process is bunshin's process_not_found.
export const runProcessInfo = async (
	req: { pid?: number; handleId?: string },
	c: CoreCall,
	pidOfHandle: (handleId: string) => number | undefined,
): Promise<OpOutcome> => {
	const pid = req.handleId === undefined ? req.pid : pidOfHandle(req.handleId);
	if (req.handleId !== undefined && pid === undefined) return processNotFound(`no handle ${req.handleId}`);
	try {
		return applied({ ...(await c.ops.info.processInfo(pid === undefined ? {} : { pid })) });
	} catch (error) {
		if (error instanceof MachineOpError && error.code === "not_found") return processNotFound(error.message);
		throw error;
	}
};
// The client parses exactly {accepted, seq, inboxPath} and rejects a partial reply (relay host #1193).
export const runMeshMessage = async (req: { topic: string; body: unknown }, c: CoreCall): Promise<OpOutcome> => {
	const r = await c.ops.info.message(req, c.ctx);
	return applied({ accepted: r.accepted, seq: r.seq, inboxPath: r.inboxPath });
};
