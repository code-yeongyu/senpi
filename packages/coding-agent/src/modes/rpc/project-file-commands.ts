/**
 * `read_project_file` / `write_project_file`: read and edit the session workspace's instruction files over RPC, so a
 * client with no filesystem access to the machine (a remote desktop) edits Rules the way a local one does.
 *
 * Reading runs nothing, so trust does not gate it; a write passes the per-write gates of `project-write-gate.ts` (trust
 * as it stands at commit, and this machine's own edit permission for that path), like the folder MCP and skill-file
 * writes. Every write names the version it replaces (`ifEtag`, `null` to create), is refused as a
 * conflict carrying the current etag when the file moved on, and lands by temp file + rename so a reader never sees a
 * half-written file. Writes to one file are serialized inside the engine.
 */

import { join } from "node:path";
import type { AgentSession } from "../../core/agent-session.ts";
import {
	PROJECT_FILE_MAX_BYTES,
	type ProjectFilePath,
	parseProjectFilePath,
	resolveProjectFile,
} from "./project-file-path.ts";
import { etagOf, readStored, type Stored, serializeWrite } from "./project-file-store.ts";
import { commitGuardedWrite, conflict, notTrusted } from "./project-write-gate.ts";
import {
	RPC_ERROR_INVALID_ARGUMENT,
	RPC_ERROR_PROJECT_FILE_NOT_ALLOWED,
	RPC_ERROR_PROJECT_FILE_TOO_LARGE,
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

/**
 * `errorData.reason` says which: `not_listed` for a path outside the allowlist, `unsafe` for an allowlisted path that
 * leads through a link or to something that is not a regular file. A client can tell an engine that predates a listed
 * path (no `reason`) from one that refuses it on this disk.
 */
function notAllowed(path: string, reason: "not_listed" | "unsafe"): Refusal {
	return {
		ok: false,
		message: `${path} is not a project file inside this workspace (AGENTS.md, CLAUDE.md, .omo/rules/** or .omo/omo.jsonc).`,
		errorCode: RPC_ERROR_PROJECT_FILE_NOT_ALLOWED,
		errorData: { path, reason },
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
	return parseProjectFilePath(path) ?? notAllowed(path, "not_listed");
}

async function readFileState(
	session: AgentSession,
	file: ProjectFilePath,
): Promise<
	{ data: RpcProjectFile; mode: number | undefined; absolute: string; missingFolders: readonly string[] } | Refusal
> {
	const cwd = session.sessionManager.getCwd();
	const resolved = await resolveProjectFile(cwd, file);
	if (!resolved.ok) return notAllowed(file.relative, "unsafe");
	const read: Stored = resolved.exists ? await readStored(resolved.absolute) : { kind: "missing" };
	if (read.kind === "refused") return notAllowed(file.relative, "unsafe");
	if (read.kind === "too_large") return tooLarge(file.relative);
	const stored = read.kind === "file" ? read.bytes : undefined;
	return {
		data: {
			cwd,
			path: file.relative,
			exists: stored !== undefined,
			content: stored === undefined ? null : stored.toString("utf8"),
			etag: stored === undefined ? null : etagOf(stored),
			projectTrusted: session.settingsManager.isProjectTrusted(),
		},
		mode: read.kind === "file" ? read.mode : undefined,
		absolute: resolved.absolute,
		missingFolders: resolved.missingFolders,
	};
}

export async function readProjectFile(session: AgentSession, path: unknown): Promise<ProjectFileResult> {
	const file = parsePath("read_project_file", path);
	if ("ok" in file) return file;
	const state = await readFileState(session, file);
	if ("ok" in state) return state;
	return { ok: true, data: state.data };
}

async function writeChecked(
	session: AgentSession,
	file: ProjectFilePath,
	content: string,
	ifEtag: string | null,
): Promise<ProjectFileResult> {
	const state = await readFileState(session, file);
	if ("ok" in state) return state;
	if (state.data.etag !== ifEtag) return conflict(file.relative, state.data.etag);
	const refused = await commitGuardedWrite(session, {
		relative: file.relative,
		absolute: state.absolute,
		content,
		expectedEtag: ifEtag,
		mode: state.mode,
		missingFolders: state.missingFolders,
	});
	return refused ?? readProjectFile(session, file.relative);
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
	if (!session.settingsManager.isProjectTrusted()) return notTrusted();
	if (Buffer.byteLength(content, "utf8") > PROJECT_FILE_MAX_BYTES) return tooLarge(file.relative);
	const key = join(session.sessionManager.getCwd(), file.relative);
	return serializeWrite(key, () => writeChecked(session, file, content, ifEtag));
}
