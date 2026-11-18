/**
 * `read_user_skill_file` / `write_user_skill_file` (omo-desktop-app#7981): read and edit the file of a user-global
 * skill the engine lists for the session (one under the agent dir's skills root or `~/.agents/skills`), by name, on
 * this machine or from another device of the account through the same verb.
 *
 * Containment: the listed file must lie inside a user skills root, taken relative to that root's real path and
 * resolved segment by segment with `lstat`, so a skill reached through a link, a `..` path or one that lives elsewhere
 * is refused (`user_skill_file_not_allowed`).
 *
 * A write from this device's own connection is pre-trusted and commits at once; a write from another device
 * commits only after this device approves it (`user-skill-approval.ts`, duty ruling on #7981).
 */

import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { AgentSession } from "../../core/agent-session.ts";
import { PROJECT_FILE_MAX_BYTES, type ProjectFilePath, resolveProjectFile } from "./project-file-path.ts";
import { etagOf, ParentMoved, readStored, replaceAtomically, serializeWrite } from "./project-file-store.ts";
import { conflict, type ProjectWriteRefusal, tooLarge } from "./project-write-gate.ts";
import type { RpcRemoteOrigin } from "./remote-origin.ts";
import {
	RPC_ERROR_INVALID_ARGUMENT,
	RPC_ERROR_PROJECT_FILE_WRITE_FAILED,
	RPC_ERROR_USER_SKILL_FILE_NOT_ALLOWED,
	RPC_ERROR_USER_SKILL_NOT_LISTED,
} from "./rpc-error-types.ts";
import {
	appendUserSkillAudit,
	askThisDevice,
	refusedByDevice,
	sha256,
	type UserSkillDecision,
	userSkillPromptTitle,
} from "./user-skill-approval.ts";

export interface RpcUserSkillFile {
	skill: string;
	path: string;
	exists: boolean;
	content: string | null;
	etag: string | null;
	/** Set when the write's audit line could not be written; the write's own outcome is unchanged. */
	auditError?: string;
}

export type UserSkillFileResult = { ok: true; data: RpcUserSkillFile } | ProjectWriteRefusal;

interface Located {
	readonly root: string;
	readonly file: ProjectFilePath;
}

interface SkillState {
	readonly data: RpcUserSkillFile;
	readonly bytes: Buffer | undefined;
	readonly mode: number | undefined;
}

function notListed(skill: string): ProjectWriteRefusal {
	return {
		ok: false,
		message: `No user skill named ${JSON.stringify(skill)} is listed for this session.`,
		errorCode: RPC_ERROR_USER_SKILL_NOT_LISTED,
		errorData: { skill },
	};
}

function notAllowed(skill: string): ProjectWriteRefusal {
	return {
		ok: false,
		message: `The file of ${JSON.stringify(skill)} is not inside a user skills folder (or is reached through a link).`,
		errorCode: RPC_ERROR_USER_SKILL_FILE_NOT_ALLOWED,
		errorData: { skill },
	};
}

function userSkillRoots(agentDir: string): readonly string[] {
	return [join(agentDir, "skills"), join(process.env.HOME || homedir(), ".agents", "skills")];
}

function rootRelative(root: string, filePath: string): ProjectFilePath | undefined {
	const path = relative(root, filePath);
	if (path === "" || isAbsolute(path)) return undefined;
	const segments = path.split(sep);
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
	return { relative: segments.join("/"), segments };
}

async function realOrUndefined(path: string): Promise<string | undefined> {
	try {
		return await realpath(path);
	} catch {
		return undefined;
	}
}

async function locateUserSkill(session: AgentSession, skill: string): Promise<Located | ProjectWriteRefusal> {
	const listed = session.resourceLoader.getSkills().skills.find((candidate) => candidate.name === skill);
	if (listed === undefined) return notListed(skill);
	for (const root of userSkillRoots(session.agentDir)) {
		const real = await realOrUndefined(root);
		if (real === undefined) continue;
		for (const base of new Set([root, real])) {
			const file = rootRelative(base, listed.filePath);
			if (file !== undefined) return { root: real, file };
		}
	}
	return notAllowed(skill);
}

async function readSkillState(
	skill: string,
	located: Located,
): Promise<(SkillState & { absolute: string }) | ProjectWriteRefusal> {
	const resolved = await resolveProjectFile(located.root, located.file);
	if (!resolved.ok || resolved.missingFolders.length > 0) return notAllowed(skill);
	const stored = resolved.exists ? await readStored(resolved.absolute) : { kind: "missing" as const };
	if (stored.kind === "refused") return notAllowed(skill);
	if (stored.kind === "too_large") return tooLarge();
	const bytes = stored.kind === "file" ? stored.bytes : undefined;
	return {
		data: {
			skill,
			path: resolved.absolute,
			exists: bytes !== undefined,
			content: bytes?.toString("utf8") ?? null,
			etag: bytes === undefined ? null : etagOf(bytes),
		},
		bytes,
		mode: stored.kind === "file" ? stored.mode : undefined,
		absolute: resolved.absolute,
	};
}

export async function readUserSkillFile(session: AgentSession, skill: unknown): Promise<UserSkillFileResult> {
	if (typeof skill !== "string") {
		return {
			ok: false,
			message: "read_user_skill_file requires a string 'skill'.",
			errorCode: RPC_ERROR_INVALID_ARGUMENT,
		};
	}
	const located = await locateUserSkill(session, skill);
	if ("ok" in located) return located;
	const state = await readSkillState(skill, located);
	return "ok" in state ? state : { ok: true, data: state.data };
}

async function commit(
	skill: string,
	located: Located,
	content: string,
	expectedEtag: string | null,
): Promise<UserSkillFileResult> {
	const state = await readSkillState(skill, located);
	if ("ok" in state) return state;
	if (state.data.etag !== expectedEtag) return conflict(state.data.path, state.data.etag);
	try {
		await replaceAtomically(state.absolute, content, state.mode);
	} catch (error) {
		if (error instanceof ParentMoved) return notAllowed(skill);
		return {
			ok: false,
			message: `Writing ${state.data.path} failed: ${error instanceof Error ? error.message : String(error)}`,
			errorCode: RPC_ERROR_PROJECT_FILE_WRITE_FAILED,
		};
	}
	const after = await readSkillState(skill, located);
	return "ok" in after ? after : { ok: true, data: after.data };
}

/** One write attempt as the audit records it: the outcome, and the file's hashes when it was located in a root. */
interface Attempt {
	readonly result: UserSkillFileResult;
	readonly decision: UserSkillDecision;
	readonly path: string | null;
	readonly before: string | null;
	readonly after: string | null;
}

const refusedBefore = (result: ProjectWriteRefusal, state?: SkillState): Attempt => ({
	result,
	decision: "refused",
	path: state?.data.path ?? null,
	before: sha256(state?.bytes),
	after: sha256(state?.bytes),
});

async function writeChecked(
	session: AgentSession,
	skill: string,
	located: Located,
	content: string,
	ifEtag: string | null,
	origin: RpcRemoteOrigin | undefined,
): Promise<Attempt> {
	const state = await readSkillState(skill, located);
	if ("ok" in state) return refusedBefore(state);
	if (Buffer.byteLength(content, "utf8") > PROJECT_FILE_MAX_BYTES) return refusedBefore(tooLarge(), state);
	if (state.data.etag !== ifEtag) return refusedBefore(conflict(state.data.path, state.data.etag), state);
	const shown = { path: state.data.path, before: sha256(state.bytes) };
	if (origin === undefined)
		return { result: await commit(skill, located, content, ifEtag), decision: "approved", ...shown, after: null };
	const decision = await askThisDevice(
		session,
		userSkillPromptTitle(origin, state.data.path, state.data.content ?? "", content),
	);
	// The file is read again after the answer: an approval covers the version the prompt showed, nothing newer.
	const result =
		decision === "approved" ? await commit(skill, located, content, ifEtag) : refusedByDevice(decision, origin);
	const now = await readSkillState(skill, located);
	return { result, decision, ...shown, after: "ok" in now ? null : sha256(now.bytes) };
}

async function attemptWrite(
	session: AgentSession,
	skill: unknown,
	content: unknown,
	ifEtag: unknown,
	origin: RpcRemoteOrigin | undefined,
): Promise<Attempt> {
	if (typeof skill !== "string" || typeof content !== "string" || (ifEtag !== null && typeof ifEtag !== "string")) {
		return refusedBefore({
			ok: false,
			message:
				"write_user_skill_file requires a string 'skill', a string 'content' and 'ifEtag' (the etag read, or null to create).",
			errorCode: RPC_ERROR_INVALID_ARGUMENT,
		});
	}
	const located = await locateUserSkill(session, skill);
	if ("ok" in located) return refusedBefore(located);
	return serializeWrite(join(located.root, located.file.relative), () =>
		writeChecked(session, skill, located, content, ifEtag, origin),
	);
}

/** The outcome as it happened; an audit line that could not be written is reported beside it, never instead of it. */
function withAuditError(result: UserSkillFileResult, auditError: string): UserSkillFileResult {
	return result.ok
		? { ok: true, data: { ...result.data, auditError } }
		: { ...result, errorData: { ...result.errorData, auditError } };
}

export async function writeUserSkillFile(
	session: AgentSession,
	skill: unknown,
	content: unknown,
	ifEtag: unknown,
	origin: RpcRemoteOrigin | undefined,
): Promise<UserSkillFileResult> {
	const attempt = await attemptWrite(session, skill, content, ifEtag, origin);
	if (origin === undefined) return attempt.result;
	const auditError = await appendUserSkillAudit(session.agentDir, {
		origin,
		path: attempt.path,
		before: attempt.before,
		after: attempt.after,
		decision: attempt.decision,
		...(attempt.result.ok ? {} : { reason: attempt.result.errorCode }),
	}).then(
		() => undefined,
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);
	return auditError === undefined ? attempt.result : withAuditError(attempt.result, auditError);
}
