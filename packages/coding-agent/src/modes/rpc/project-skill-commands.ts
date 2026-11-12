/**
 * `read_project_skill_file` / `write_project_skill_file` (senpi#6485): read and edit the file of a skill the engine
 * lists for the session, so a remote client edits skills like a local one.
 *
 * Only a listed skill's own file is reachable, and only while it lies inside the session folder: its path is taken
 * relative to the folder and resolved segment by segment with `lstat`, so a skill reached through a folder link or a
 * file link that leaves the folder (or a skill that lives elsewhere, like a global one) is refused. A file whose
 * real path lies in the agent dir or in any user-global skill root the engine loads (`~/.agents/skills`, a selected
 * root) is user-global configuration and refused too, whatever the session folder is. Reading runs nothing, so
 * trust does not gate it; a write names the version it replaces and passes `project-write-gate.ts`.
 */

import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { AgentSession } from "../../core/agent-session.ts";
import {
	insideUserGlobalRoots,
	PROJECT_FILE_MAX_BYTES,
	type ProjectFilePath,
	resolveProjectFile,
} from "./project-file-path.ts";
import { etagOf, readStored, type Stored, serializeWrite } from "./project-file-store.ts";
import {
	commitGuardedWrite,
	conflict,
	notAllowed,
	notTrusted,
	type ProjectWriteRefusal,
	projectTrustedForWrite,
	tooLarge,
} from "./project-write-gate.ts";
import { RPC_ERROR_INVALID_ARGUMENT, RPC_ERROR_PROJECT_SKILL_NOT_LISTED } from "./rpc-error-types.ts";

export interface RpcProjectSkillFile {
	cwd: string;
	skill: string;
	/** The folder-relative path of the skill's file. */
	path: string;
	exists: boolean;
	content: string | null;
	/** Opaque version of the stored bytes; compare it, never parse it. */
	etag: string | null;
	projectTrusted: boolean;
}

export type ProjectSkillFileResult = { ok: true; data: RpcProjectSkillFile } | ProjectWriteRefusal;

interface SkillFileState {
	readonly data: RpcProjectSkillFile;
	readonly absolute: string;
	readonly mode: number | undefined;
	readonly missingFolders: readonly string[];
}

function notListed(skill: string): ProjectWriteRefusal {
	return {
		ok: false,
		message: `No skill named ${JSON.stringify(skill)} is listed for this session.`,
		errorCode: RPC_ERROR_PROJECT_SKILL_NOT_LISTED,
		errorData: { skill },
	};
}

function folderRelative(root: string, filePath: string): ProjectFilePath | undefined {
	const path = relative(root, filePath);
	if (path === "" || isAbsolute(path)) return undefined;
	const segments = path.split(sep);
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
	return { relative: segments.join("/"), segments };
}

async function locateSkillFile(session: AgentSession, skill: string): Promise<ProjectFilePath | ProjectWriteRefusal> {
	const listed = session.resourceLoader.getSkills().skills.find((candidate) => candidate.name === skill);
	if (listed === undefined) return notListed(skill);
	const cwd = session.sessionManager.getCwd();
	for (const root of new Set([cwd, await realpath(cwd)])) {
		const file = folderRelative(root, listed.filePath);
		if (file !== undefined) return file;
	}
	return notAllowed(listed.filePath);
}

async function readSkillState(
	session: AgentSession,
	skill: string,
	file: ProjectFilePath,
): Promise<SkillFileState | ProjectWriteRefusal> {
	const cwd = session.sessionManager.getCwd();
	const resolved = await resolveProjectFile(cwd, file);
	if (
		!resolved.ok ||
		(await insideUserGlobalRoots(
			session.agentDir,
			session.resourceLoader.getUserSkillRoots?.() ?? [],
			resolved.absolute,
		))
	) {
		return notAllowed(file.relative);
	}
	const stored: Stored = resolved.exists ? await readStored(resolved.absolute) : { kind: "missing" };
	if (stored.kind === "refused") return notAllowed(file.relative);
	if (stored.kind === "too_large") return tooLarge();
	return {
		data: {
			cwd,
			skill,
			path: file.relative,
			exists: stored.kind === "file",
			content: stored.kind === "file" ? stored.bytes.toString("utf8") : null,
			etag: stored.kind === "file" ? etagOf(stored.bytes) : null,
			projectTrusted: session.settingsManager.isProjectTrusted(),
		},
		absolute: resolved.absolute,
		mode: stored.kind === "file" ? stored.mode : undefined,
		missingFolders: resolved.missingFolders,
	};
}

export async function readProjectSkillFile(session: AgentSession, skill: unknown): Promise<ProjectSkillFileResult> {
	if (typeof skill !== "string") {
		return {
			ok: false,
			message: "read_project_skill_file requires a string 'skill'.",
			errorCode: RPC_ERROR_INVALID_ARGUMENT,
		};
	}
	const file = await locateSkillFile(session, skill);
	if ("ok" in file) return file;
	const state = await readSkillState(session, skill, file);
	return "ok" in state ? state : { ok: true, data: state.data };
}

async function writeChecked(
	session: AgentSession,
	skill: string,
	file: ProjectFilePath,
	content: string,
	ifEtag: string | null,
): Promise<ProjectSkillFileResult> {
	const state = await readSkillState(session, skill, file);
	if ("ok" in state) return state;
	if (state.data.etag !== ifEtag) return conflict(file.relative, state.data.etag);
	const refused = await commitGuardedWrite(session, {
		relative: file.relative,
		absolute: state.absolute,
		content,
		expectedEtag: state.data.etag,
		mode: state.mode,
		missingFolders: state.missingFolders,
	});
	return refused ?? readProjectSkillFile(session, skill);
}

export async function writeProjectSkillFile(
	session: AgentSession,
	skill: unknown,
	content: unknown,
	ifEtag: unknown,
): Promise<ProjectSkillFileResult> {
	if (typeof skill !== "string" || typeof content !== "string" || (ifEtag !== null && typeof ifEtag !== "string")) {
		return {
			ok: false,
			message:
				"write_project_skill_file requires a string 'skill', a string 'content' and 'ifEtag' (the etag read, or null to create).",
			errorCode: RPC_ERROR_INVALID_ARGUMENT,
		};
	}
	if (!(await projectTrustedForWrite(session))) return notTrusted();
	if (Buffer.byteLength(content, "utf8") > PROJECT_FILE_MAX_BYTES) return tooLarge();
	const file = await locateSkillFile(session, skill);
	if ("ok" in file) return file;
	const key = join(session.sessionManager.getCwd(), file.relative);
	return serializeWrite(key, () => writeChecked(session, skill, file, content, ifEtag));
}
