/**
 * `read_project_file` / `write_project_file`: read and edit the session workspace's instruction files over RPC, so a
 * client with no filesystem access to the machine (a remote desktop) edits Rules the way a local one does.
 *
 * Reading runs nothing, so trust does not gate it; writing is refused while the project is untrusted, like
 * `set_project_setting`. Every write names the version it replaces (`ifEtag`, `null` to create), is refused as a
 * conflict carrying the current etag when the file moved on, and lands by temp file + rename so a reader never sees a
 * half-written file. Writes to one file are serialized inside the engine.
 */

import { createHash, randomUUID } from "node:crypto";
import { open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AgentSession } from "../../core/agent-session.ts";
import {
	createMissingFolders,
	NO_FOLLOW,
	PROJECT_FILE_MAX_BYTES,
	type ProjectFilePath,
	parseProjectFilePath,
	resolveProjectFile,
} from "./project-file-path.ts";
import {
	RPC_ERROR_INVALID_ARGUMENT,
	RPC_ERROR_PROJECT_FILE_CONFLICT,
	RPC_ERROR_PROJECT_FILE_NOT_ALLOWED,
	RPC_ERROR_PROJECT_FILE_TOO_LARGE,
	RPC_ERROR_PROJECT_FILE_WRITE_FAILED,
	RPC_ERROR_PROJECT_NOT_TRUSTED,
} from "./rpc-error-types.ts";

export interface RpcProjectFile {
	cwd: string;
	/** The canonical workspace-relative path. */
	path: string;
	exists: boolean;
	content: string | null;
	/** Opaque version of the stored bytes; compare it, never parse it. */
	etag: string | null;
	projectTrusted: boolean;
}

export type ProjectFileResult =
	| { ok: true; data: RpcProjectFile }
	| { ok: false; message: string; errorCode: string; errorData?: Record<string, unknown> };

type Refusal = Extract<ProjectFileResult, { ok: false }>;

const writeChains = new Map<string, Promise<unknown>>();

function etagOf(bytes: Buffer): string {
	return `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
}

function notAllowed(path: string): Refusal {
	return {
		ok: false,
		message: `${path} is not an instruction file inside this workspace (AGENTS.md, CLAUDE.md or .omo/rules/**).`,
		errorCode: RPC_ERROR_PROJECT_FILE_NOT_ALLOWED,
		errorData: { path },
	};
}

function tooLarge(path: string): Refusal {
	return {
		ok: false,
		message: `${path} is larger than ${PROJECT_FILE_MAX_BYTES} bytes.`,
		errorCode: RPC_ERROR_PROJECT_FILE_TOO_LARGE,
		errorData: { limitBytes: PROJECT_FILE_MAX_BYTES },
	};
}

function parsePath(command: string, path: unknown): ProjectFilePath | Refusal {
	if (typeof path !== "string") {
		return { ok: false, message: `${command} requires a string 'path'.`, errorCode: RPC_ERROR_INVALID_ARGUMENT };
	}
	return parseProjectFilePath(path) ?? notAllowed(path);
}

/** Reads the stored bytes without following a link; `undefined` when the file is gone. */
async function readStored(absolute: string): Promise<Buffer | undefined> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(absolute, "r", NO_FOLLOW);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
	try {
		return await handle.readFile();
	} finally {
		await handle.close();
	}
}

async function readFileState(
	session: AgentSession,
	file: ProjectFilePath,
): Promise<{ data: RpcProjectFile; bytes: number; absolute: string; missingFolders: readonly string[] } | Refusal> {
	const cwd = session.sessionManager.getCwd();
	const resolved = await resolveProjectFile(cwd, file);
	if (!resolved.ok) return notAllowed(file.relative);
	let stored: Buffer | undefined;
	try {
		stored = resolved.exists ? await readStored(resolved.absolute) : undefined;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ELOOP") return notAllowed(file.relative);
		throw error;
	}
	return {
		data: {
			cwd,
			path: file.relative,
			exists: stored !== undefined,
			content: stored === undefined ? null : stored.toString("utf8"),
			etag: stored === undefined ? null : etagOf(stored),
			projectTrusted: session.settingsManager.isProjectTrusted(),
		},
		bytes: stored?.byteLength ?? 0,
		absolute: resolved.absolute,
		missingFolders: resolved.missingFolders,
	};
}

export async function readProjectFile(session: AgentSession, path: unknown): Promise<ProjectFileResult> {
	const file = parsePath("read_project_file", path);
	if ("ok" in file) return file;
	const state = await readFileState(session, file);
	if ("ok" in state) return state;
	if (state.bytes > PROJECT_FILE_MAX_BYTES) return tooLarge(file.relative);
	return { ok: true, data: state.data };
}

async function replaceAtomically(absolute: string, content: string): Promise<void> {
	const temp = join(dirname(absolute), `.${basename(absolute)}.${randomUUID()}.tmp`);
	try {
		await writeFile(temp, content, { flag: "wx", mode: 0o644 });
		await rename(temp, absolute);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

async function writeChecked(
	session: AgentSession,
	file: ProjectFilePath,
	content: string,
	ifEtag: string | null,
): Promise<ProjectFileResult> {
	const state = await readFileState(session, file);
	if ("ok" in state) return state;
	if (state.data.etag !== ifEtag) {
		return {
			ok: false,
			message: `${file.relative} changed since that version was read; read it again before writing.`,
			errorCode: RPC_ERROR_PROJECT_FILE_CONFLICT,
			errorData: { currentEtag: state.data.etag, exists: state.data.exists },
		};
	}
	try {
		if (!(await createMissingFolders(state.missingFolders))) return notAllowed(file.relative);
		await replaceAtomically(state.absolute, content);
	} catch (error) {
		return {
			ok: false,
			message: `Writing ${file.relative} failed: ${error instanceof Error ? error.message : String(error)}`,
			errorCode: RPC_ERROR_PROJECT_FILE_WRITE_FAILED,
		};
	}
	return readProjectFile(session, file.relative);
}

export async function writeProjectFile(
	session: AgentSession,
	path: unknown,
	content: unknown,
	ifEtag: unknown,
): Promise<ProjectFileResult> {
	const file = parsePath("write_project_file", path);
	if ("ok" in file) return file;
	if (typeof content !== "string" || (ifEtag !== null && typeof ifEtag !== "string")) {
		return {
			ok: false,
			message: "write_project_file requires a string 'content' and 'ifEtag' (the etag read, or null to create).",
			errorCode: RPC_ERROR_INVALID_ARGUMENT,
		};
	}
	if (!session.settingsManager.isProjectTrusted()) {
		return {
			ok: false,
			message: "Project is not trusted; refusing to write project files. Trust it with set_project_trust first.",
			errorCode: RPC_ERROR_PROJECT_NOT_TRUSTED,
		};
	}
	if (Buffer.byteLength(content, "utf8") > PROJECT_FILE_MAX_BYTES) return tooLarge(file.relative);
	const key = join(session.sessionManager.getCwd(), file.relative);
	const previous = writeChains.get(key) ?? Promise.resolve();
	const next = previous.then(() => writeChecked(session, file, content, ifEtag));
	writeChains.set(key, next);
	try {
		return await next;
	} finally {
		if (writeChains.get(key) === next) writeChains.delete(key);
	}
}
