/**
 * The approval half of `write_user_skill_file` (omo-desktop-app#7981): a write from another device commits only once
 * someone on THIS device approves it through the session's local grant presentation, which only an attached local
 * client registers (never a remote or delegated connection, `security-presentations.ts`), so the requester cannot
 * answer its own question. There is no "always allow" choice. Every such attempt leaves one local audit line.
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSession } from "../../core/agent-session.ts";
import { getMcpGrantPresentation, selectLocalGrant } from "../../core/mcp-grant-presentations.ts";
import { createUnifiedPatch } from "../../core/tools/unified-diff.ts";
import type { ProjectWriteRefusal } from "./project-write-gate.ts";
import type { RpcRemoteOrigin } from "./remote-origin.ts";
import { RPC_ERROR_USER_SKILL_WRITE_DECLINED, RPC_ERROR_USER_SKILL_WRITE_UNCONFIRMED } from "./rpc-error-types.ts";

export const USER_SKILL_ALLOW = "Allow this change";
export const USER_SKILL_DENY = "Deny";
export const USER_SKILL_AUDIT_FILE = join("audit", "user-skill-writes.jsonl");
// A skill file may be 512 KiB; a longer diff is cut and the prompt says so.
const PROMPT_DIFF_MAX_CHARACTERS = 20_000;

export type UserSkillDecision = "approved" | "denied" | "unconfirmed";

export const sha256 = (bytes: Buffer | undefined): string | null =>
	bytes === undefined ? null : createHash("sha256").update(bytes).digest("hex");

const originName = (origin: RpcRemoteOrigin): string => origin.deviceName ?? origin.deviceId;

/** Who asks, which file, and exactly what changes: a new file's diff is all of its content. */
export function userSkillPromptTitle(origin: RpcRemoteOrigin, path: string, before: string, after: string): string {
	const patch = createUnifiedPatch(path, path, before, after);
	const shown =
		patch.length > PROMPT_DIFF_MAX_CHARACTERS
			? `${patch.slice(0, PROMPT_DIFF_MAX_CHARACTERS)}\n... ${patch.length - PROMPT_DIFF_MAX_CHARACTERS} more characters of the change are not shown; deny if unsure.`
			: patch;
	return `${originName(origin)} wants to change a user skill on this machine.\nFile: ${path}\n\n${shown}`;
}

export async function askThisDevice(session: AgentSession, title: string): Promise<UserSkillDecision> {
	const select = getMcpGrantPresentation(session.sessionId);
	if (select === undefined) return "unconfirmed";
	const answer = await selectLocalGrant(select, title, [USER_SKILL_ALLOW, USER_SKILL_DENY]);
	if (answer === USER_SKILL_ALLOW) return "approved";
	return answer === USER_SKILL_DENY ? "denied" : "unconfirmed";
}

export async function appendUserSkillAudit(
	agentDir: string,
	entry: {
		readonly origin: RpcRemoteOrigin;
		readonly path: string;
		readonly before: string | null;
		readonly after: string | null;
		readonly decision: UserSkillDecision;
	},
): Promise<void> {
	await mkdir(join(agentDir, "audit"), { recursive: true, mode: 0o700 });
	const line = {
		at: new Date().toISOString(),
		originDeviceId: entry.origin.deviceId,
		...(entry.origin.deviceName === undefined ? {} : { originDeviceName: entry.origin.deviceName }),
		path: entry.path,
		sha256Before: entry.before,
		sha256After: entry.after,
		decision: entry.decision,
	};
	await appendFile(join(agentDir, USER_SKILL_AUDIT_FILE), `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

export function refusedByDevice(decision: UserSkillDecision, origin: RpcRemoteOrigin): ProjectWriteRefusal {
	return decision === "denied"
		? {
				ok: false,
				message: "The change was denied on the machine that holds the skill.",
				errorCode: RPC_ERROR_USER_SKILL_WRITE_DECLINED,
				errorData: { originDeviceId: origin.deviceId },
			}
		: {
				ok: false,
				message:
					"Nobody approved the change on the machine that holds the skill: it must be approved in an app open on that machine.",
				errorCode: RPC_ERROR_USER_SKILL_WRITE_UNCONFIRMED,
				errorData: { originDeviceId: origin.deviceId },
			};
}
