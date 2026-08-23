import { unlink } from "node:fs/promises";
import type { ReadonlySessionManager } from "../../../session-manager.ts";
import type { ExtensionCommandContext } from "../../types.ts";
import { type BtwSideMetadata, readBtwSideMetadata } from "./session-catalog.ts";

export interface CurrentBtwSide {
	sessionId: string;
	sessionDir: string;
	sessionPath: string;
	metadata: BtwSideMetadata;
}

export interface DeleteSessionFileResult {
	ok: boolean;
	method: "trash" | "unlink";
	error?: string;
}

export function createBtwParentSwitchOptions(
	metadata: BtwSideMetadata,
	sessionDir: string,
): {
	sessionDir: string;
	withSession?: (ctx: ExtensionCommandContext) => Promise<void>;
} {
	const parentLeafId = metadata.parentLeafId;
	return {
		sessionDir,
		withSession: parentLeafId
			? async (ctx) => {
					await ctx.navigateTree(parentLeafId, { summarize: false });
				}
			: undefined,
	};
}

export async function deleteBtwSessionFile(sessionPath: string): Promise<DeleteSessionFileResult> {
	try {
		await unlink(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return { ok: true, method: "unlink" };
		}
		return {
			ok: false,
			method: "unlink",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function readCurrentBtwSide(sessionManager: ReadonlySessionManager): CurrentBtwSide | undefined {
	const sessionPath = sessionManager.getSessionFile();
	if (!sessionPath) return undefined;
	const metadata = readBtwSideMetadata(sessionManager.getEntries());
	return metadata
		? {
				sessionId: sessionManager.getSessionId(),
				sessionDir: sessionManager.getSessionDir(),
				sessionPath,
				metadata,
			}
		: undefined;
}

function hasMatchingBtwParent(ctx: ExtensionCommandContext, current: CurrentBtwSide): boolean {
	try {
		if (ctx.inspectSession(current.metadata.parentSessionPath).id === current.metadata.parentSessionId) {
			return true;
		}
	} catch {
		// Report the same unavailable-parent result for missing and mismatched destinations.
	}
	ctx.ui.notify("The original Main session is no longer available.", "warning");
	return false;
}

export async function returnToBtwParent(input: {
	ctx: ExtensionCommandContext;
	current: CurrentBtwSide | undefined;
}): Promise<void> {
	if (!input.current) {
		input.ctx.ui.notify("This is not a retained BTW session.", "warning");
		return;
	}
	if (!hasMatchingBtwParent(input.ctx, input.current)) return;
	const options = createBtwParentSwitchOptions(input.current.metadata, input.current.sessionDir);
	await input.ctx.switchSession(input.current.metadata.parentSessionPath, options);
}

export async function closeRetainedBtwSide(input: {
	ctx: ExtensionCommandContext;
	current: CurrentBtwSide | undefined;
	deleteSessionFile: (sessionPath: string) => Promise<DeleteSessionFileResult>;
}): Promise<void> {
	const current = input.current;
	if (!current) {
		input.ctx.ui.notify("This is not a retained BTW session.", "warning");
		return;
	}
	if (!hasMatchingBtwParent(input.ctx, current)) return;
	await input.ctx.switchSession(current.metadata.parentSessionPath, {
		sessionDir: current.sessionDir,
		withSession: async (nextCtx) => {
			let warning: string | undefined;
			try {
				if (nextCtx.inspectSession(current.sessionPath).id !== current.sessionId) {
					warning = "The visible BTW session changed before deletion.";
				}
			} catch {
				warning = "The visible BTW session is no longer available for deletion.";
			}
			if (!warning) {
				const result = await input.deleteSessionFile(current.sessionPath);
				if (!result.ok) {
					warning = `Failed to delete BTW session: ${result.error ?? "unknown error"}`;
				}
			}
			if (warning) nextCtx.ui.notify(warning, "warning");
			await createBtwParentSwitchOptions(current.metadata, current.sessionDir).withSession?.(nextCtx);
		},
	});
}
