import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import type { Skill } from "./skills.ts";

const SCHEME = "skill://";

/** Stable within a session, without disclosing a filesystem root or a session id. */
export function skillDisplayRoot(root: string, sessionId: string | undefined): string {
	if (!sessionId) throw new Error("A session id is required to advertise an opaque skill location");
	const key = createHash("sha256")
		.update(JSON.stringify([sessionId, root]))
		.digest("hex");
	return `${SCHEME}${key}`;
}

export function skillDisplayPath(path: string, sessionId: string | undefined): string {
	const directory = dirname(path);
	return `${skillDisplayRoot(dirname(directory), sessionId)}/${basename(directory)}/${basename(path)}`;
}

/**
 * The built-in read's argument preparation runs on a detached copy before validation
 * and permission hooks. Only exact files in this session's loaded skill inventory
 * resolve; this is neither a directory mount nor a general path rewrite.
 */
export function prepareSkillReadArguments(args: unknown, sessionId: string, skills: readonly Skill[]): unknown {
	if (typeof args !== "object" || args === null || !("path" in args) || typeof args.path !== "string") return args;
	if (!args.path.startsWith(SCHEME)) return args;
	for (const skill of skills) {
		if (!skill.disableModelInvocation && skillDisplayPath(skill.filePath, sessionId) === args.path) {
			return { ...args, path: skill.filePath };
		}
	}
	throw new Error("Unknown skill location for this session");
}
