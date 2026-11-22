/**
 * The gates every folder-file write over RPC passes right before it commits (senpi#6485): the project trust as it
 * stands at that moment, and the permission decision the same edit would get from this machine's own session.
 *
 * Trust is read per write, never from session open: the session's live trust (which `set_project_trust` moves), and,
 * unless a launch flag or the Full access preset decided it, the saved decision another session may have changed since.
 * The permission decision is the permission system's own dispatch authorizer, asked for a `write` of the absolute path
 * with the content to write, so rules, presets, "Always" answers and the ask prompt apply exactly as to the write tool.
 */

import { randomUUID } from "node:crypto";
import type { AgentSession } from "../../core/agent-session.ts";
import {
	authorizeToolDispatch,
	hasDispatchAuthorizer,
} from "../../core/extensions/builtin/permission-system/dispatch.ts";
import { getSavedProjectTrust, ProjectTrustStore } from "../../core/trust-manager.ts";
import { createMissingFolders, PROJECT_FILE_MAX_BYTES } from "./project-file-path.ts";
import { etagOf, ParentMoved, readStored, replaceAtomically } from "./project-file-store.ts";
import {
	RPC_ERROR_PROJECT_FILE_CONFLICT,
	RPC_ERROR_PROJECT_FILE_NOT_ALLOWED,
	RPC_ERROR_PROJECT_FILE_PERMISSION_DENIED,
	RPC_ERROR_PROJECT_FILE_TOO_LARGE,
	RPC_ERROR_PROJECT_FILE_WRITE_FAILED,
	RPC_ERROR_PROJECT_NOT_TRUSTED,
} from "./rpc-error-types.ts";

export interface ProjectWriteRefusal {
	readonly ok: false;
	readonly message: string;
	readonly errorCode: string;
	readonly errorData?: Record<string, unknown>;
}

export interface GuardedWrite {
	readonly relative: string;
	readonly absolute: string;
	readonly content: string;
	/** The stored version the write replaces (`null`: none); it must still be current when the write commits. */
	readonly expectedEtag: string | null;
	readonly mode: number | undefined;
	readonly missingFolders: readonly string[];
}

const RPC_WRITE_IDENTITY = { owner: {}, metadata: "rpc:project-folder-file" };

export function notAllowed(relative: string): ProjectWriteRefusal {
	return {
		ok: false,
		message: `${relative} is not a file this folder lets an RPC client edit (outside the folder, or through a link).`,
		errorCode: RPC_ERROR_PROJECT_FILE_NOT_ALLOWED,
		errorData: { path: relative },
	};
}

export function tooLarge(): ProjectWriteRefusal {
	return {
		ok: false,
		message: `The file is larger than ${PROJECT_FILE_MAX_BYTES} bytes.`,
		errorCode: RPC_ERROR_PROJECT_FILE_TOO_LARGE,
		errorData: { limitBytes: PROJECT_FILE_MAX_BYTES },
	};
}

export function conflict(relative: string, currentEtag: string | null): ProjectWriteRefusal {
	return {
		ok: false,
		message: `${relative} changed since that version was read; read it again before writing.`,
		errorCode: RPC_ERROR_PROJECT_FILE_CONFLICT,
		errorData: { currentEtag, exists: currentEtag !== null },
	};
}

export function notTrusted(): ProjectWriteRefusal {
	return {
		ok: false,
		message: "Project is not trusted; refusing to write project files. Trust it with set_project_trust first.",
		errorCode: RPC_ERROR_PROJECT_NOT_TRUSTED,
	};
}

function permissionDenied(reason: string): ProjectWriteRefusal {
	return { ok: false, message: reason, errorCode: RPC_ERROR_PROJECT_FILE_PERMISSION_DENIED };
}

export async function projectTrustedForWrite(session: AgentSession): Promise<boolean> {
	const settings = session.settingsManager;
	if (!settings.isProjectTrusted()) return false;
	if (settings.isProjectTrustLocked() || settings.isTrustFromFullAccess()) return true;
	const store = new ProjectTrustStore(session.agentDir);
	return (await getSavedProjectTrust(store, session.sessionManager.getCwd())) !== false;
}

/**
 * The permission decision for writing `content` to `absolute`, as the write tool gets it in this session; the returned
 * fence re-checks it immediately before the commit. A runtime without the permission system writes like its tools do.
 */
async function authorizeWrite(
	session: AgentSession,
	absolute: string,
	content: string,
): Promise<(() => boolean) | ProjectWriteRefusal> {
	const ctx = session.extensionRunner.createContext();
	const key = ctx.sessionManager;
	if (key === undefined || !hasDispatchAuthorizer(key)) {
		const enforced =
			ctx.loadedExtensionPaths === undefined ||
			ctx.loadedExtensionPaths.some((path) => path.includes("permission-system"));
		return enforced ? permissionDenied("Permission authorizer is unavailable.") : () => true;
	}
	const request = {
		toolCallId: `rpc-project-write-${randomUUID()}`,
		toolName: "write",
		input: { path: absolute, content },
		identity: RPC_WRITE_IDENTITY,
	};
	try {
		return await authorizeToolDispatch(key, request, ctx, undefined);
	} catch (error) {
		return permissionDenied(error instanceof Error ? error.message : String(error));
	}
}

/**
 * Commits one checked write: the permission decision, then trust and the expected version again (an ask can take
 * a while), the permission fence, and the atomic replace. Answers a refusal, or `undefined` once the file is written.
 */
export async function commitGuardedWrite(
	session: AgentSession,
	write: GuardedWrite,
): Promise<ProjectWriteRefusal | undefined> {
	const fence = await authorizeWrite(session, write.absolute, write.content);
	if (typeof fence !== "function") return fence;
	if (!(await projectTrustedForWrite(session))) return notTrusted();
	const stored = write.missingFolders.length > 0 ? { kind: "missing" as const } : await readStored(write.absolute);
	if (stored.kind === "refused") return notAllowed(write.relative);
	if (stored.kind === "too_large") return tooLarge();
	const currentEtag = stored.kind === "file" ? etagOf(stored.bytes) : null;
	if (currentEtag !== write.expectedEtag) return conflict(write.relative, currentEtag);
	if (!fence()) return permissionDenied("The permission decision for this write changed before it was committed.");
	try {
		if (!(await createMissingFolders(write.missingFolders))) return notAllowed(write.relative);
		await replaceAtomically(write.absolute, write.content, write.mode);
	} catch (error) {
		if (error instanceof ParentMoved) return notAllowed(write.relative);
		return {
			ok: false,
			message: `Writing ${write.relative} failed: ${error instanceof Error ? error.message : String(error)}`,
			errorCode: RPC_ERROR_PROJECT_FILE_WRITE_FAILED,
		};
	}
	return undefined;
}
