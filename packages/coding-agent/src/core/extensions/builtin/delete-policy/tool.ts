/**
 * `trash`: the model's first-class way to remove files and directories. Each path moves to the OS trash
 * (restorable with `senpi trash restore <id>`); `permanent: true` with a reason deletes for good, is audited,
 * and is refused when the user set `deletePolicy.mode` to `trash-only`.
 */
import { resolve } from "node:path";
import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI } from "../../types.ts";
import type { DeleteAuditRow } from "./audit.ts";
import type { TrashEntry } from "./entries.ts";
import { resolveDeletePolicy } from "./policy.ts";
import { deletePermanently, type TrashScope, trashPath } from "./trash.ts";
import { TrashError } from "./trash-error.ts";

export const TRASH_TOOL = "trash";

export const TRASH_TOOL_DESCRIPTION = `Move files or directories to the trash instead of deleting them. Use this rather than \`rm -rf\`, \`git worktree remove\` or \`git clean\` whenever you remove something you did not create in this session's temp directory.

- \`paths\`: what to remove (absolute, or relative to the working directory). Each path moves on its own; one refusal does not stop the others.
- \`reason\`: why it is being removed; recorded with the entry.
- \`permanent: true\`: delete for good instead. Only when the data must not survive; it is written to the audit log, and refused if the user set the delete policy to trash-only.

A trashed item frees no disk space until the trash is emptied. Restore with \`senpi trash restore <id>\`; list with \`senpi trash list\`.`;

export const trashToolSchema = Type.Object(
	{
		paths: Type.Array(Type.String(), { minItems: 1, description: "Files or directories to remove." }),
		reason: Type.String({ description: "Why these paths are being removed." }),
		permanent: Type.Optional(
			Type.Boolean({ description: "Delete for good instead of trashing. Audited; refused under trash-only." }),
		),
	},
	{ additionalProperties: false },
);

export interface TrashToolParams {
	readonly paths: readonly string[];
	readonly reason: string;
	readonly permanent?: boolean;
}

export type TrashToolOutcome =
	| { readonly kind: "trashed"; readonly path: string; readonly entry: TrashEntry }
	| { readonly kind: "deleted"; readonly path: string; readonly audit: DeleteAuditRow }
	| { readonly kind: "refused"; readonly path: string; readonly code: TrashError["code"]; readonly message: string };

export interface TrashToolDetails {
	readonly outcomes: readonly TrashToolOutcome[];
}

async function handlePath(scope: TrashScope, params: TrashToolParams, path: string): Promise<TrashToolOutcome> {
	try {
		if (params.permanent === true) {
			return { kind: "deleted", path, audit: await deletePermanently(scope, path, params.reason) };
		}
		return { kind: "trashed", path, entry: await trashPath(scope, path, params.reason) };
	} catch (error) {
		if (error instanceof TrashError) return { kind: "refused", path, code: error.code, message: error.message };
		throw error;
	}
}

function describe(outcome: TrashToolOutcome): string {
	switch (outcome.kind) {
		case "trashed":
			return `moved to trash: ${outcome.path} (${outcome.entry.bytes} bytes; restore: senpi trash restore ${outcome.entry.id})`;
		case "deleted":
			return `deleted permanently: ${outcome.path} (${outcome.audit.bytes} bytes, audited)`;
		case "refused":
			return `refused: ${outcome.path}: ${outcome.message}`;
	}
}

export interface TrashToolSession {
	readonly agentDir: string;
	readonly cwd: string;
	readonly sessionId: string;
}

export async function runTrashTool(
	params: TrashToolParams,
	session: TrashToolSession,
	settings: object,
): Promise<AgentToolResult<TrashToolDetails>> {
	if (params.reason.trim().length === 0) throw new Error("trash needs a non-empty reason.");
	const scope: TrashScope = {
		agentDir: session.agentDir,
		policy: resolveDeletePolicy(settings),
		sessionId: session.sessionId,
		actor: "model",
	};
	const outcomes: TrashToolOutcome[] = [];
	for (const path of params.paths) outcomes.push(await handlePath(scope, params, resolve(session.cwd, path)));
	return { content: [{ type: "text", text: outcomes.map(describe).join("\n") }], details: { outcomes } };
}

export function registerTrashTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TRASH_TOOL,
		label: "Trash",
		description: TRASH_TOOL_DESCRIPTION,
		parameters: trashToolSchema,
		exposure: "search",
		searchKeywords: ["delete", "remove", "rm", "trash", "worktree remove", "clean", "recycle"],
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<TrashToolDetails>> {
			const session = { agentDir: ctx.agentDir, cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() };
			return runTrashTool(params, session, pi.getSettings());
		},
	});
}
