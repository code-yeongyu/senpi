import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, rename, unlink } from "node:fs/promises";
import type { ReadonlySessionManager } from "../../../session-manager.ts";
import type { ExtensionCommandContext, SessionSourceExpectation } from "../../types.ts";
import { type BtwSideMetadata, readBtwSideMetadata } from "./session-catalog.ts";

export interface CurrentBtwSide {
	sessionId: string;
	sessionDir: string;
	sessionPath: string;
	sourceLeafId: string | null;
	metadata: BtwSideMetadata;
}

export interface DeleteSessionFileResult {
	ok: boolean;
	method: "trash" | "unlink";
	error?: string;
}

export interface DeleteBtwSessionFileInput {
	sessionPath: string;
	expectedSessionId: string;
	inspectSessionId: (sessionPath: string) => string | undefined;
}

export function captureBtwSourceExpectation(
	ctx: Pick<ExtensionCommandContext, "getSourceActivityGeneration" | "isIdle" | "sessionManager">,
): SessionSourceExpectation {
	return {
		sessionId: ctx.sessionManager.getSessionId(),
		leafId: ctx.sessionManager.getLeafId(),
		wasIdle: ctx.isIdle(),
		activityGeneration: ctx.getSourceActivityGeneration?.() ?? 0,
	};
}

export function createBtwParentSwitchOptions(
	metadata: BtwSideMetadata,
	sessionDir: string,
	expectedSource?: SessionSourceExpectation,
): {
	expectedSessionId: string;
	expectedSource?: SessionSourceExpectation;
	sessionDir: string;
	withSession?: (ctx: ExtensionCommandContext) => Promise<void>;
} {
	const parentLeafId = metadata.parentLeafId;
	return {
		expectedSessionId: metadata.parentSessionId,
		expectedSource,
		sessionDir,
		withSession: parentLeafId
			? async (ctx) => {
					await ctx.navigateTree(parentLeafId, { summarize: false });
				}
			: undefined,
	};
}

function deletionFailure(error: unknown): DeleteSessionFileResult {
	return {
		ok: false,
		method: "unlink",
		error: error instanceof Error ? error.message : String(error),
	};
}

function isFileError(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function restoreQuarantinedSession(quarantinePath: string, sessionPath: string): Promise<string | undefined> {
	try {
		await copyFile(quarantinePath, sessionPath, constants.COPYFILE_EXCL);
		await unlink(quarantinePath);
		return undefined;
	} catch (error) {
		if (isFileError(error, "EEXIST")) {
			return `A replacement appeared during deletion; preserved the quarantined session at ${quarantinePath}`;
		}
		return `Failed to restore the quarantined BTW session: ${error instanceof Error ? error.message : String(error)}`;
	}
}

export async function deleteBtwSessionFile(input: DeleteBtwSessionFileInput): Promise<DeleteSessionFileResult> {
	const changedMessage = "The visible BTW session changed before deletion.";
	try {
		if (input.inspectSessionId(input.sessionPath) !== input.expectedSessionId) {
			return deletionFailure(changedMessage);
		}
	} catch {
		return deletionFailure("The visible BTW session is no longer available for deletion.");
	}

	const quarantinePath = `${input.sessionPath}.btw-delete-${randomUUID()}`;
	try {
		await rename(input.sessionPath, quarantinePath);
	} catch (error) {
		if (isFileError(error, "ENOENT")) return { ok: true, method: "unlink" };
		return deletionFailure(error);
	}

	let quarantinedSessionId: string | undefined;
	try {
		quarantinedSessionId = input.inspectSessionId(quarantinePath);
	} catch {
		const restoreError = await restoreQuarantinedSession(quarantinePath, input.sessionPath);
		return deletionFailure(restoreError ?? "The quarantined BTW session could not be validated.");
	}
	if (quarantinedSessionId !== input.expectedSessionId) {
		const restoreError = await restoreQuarantinedSession(quarantinePath, input.sessionPath);
		return deletionFailure(restoreError ?? changedMessage);
	}

	try {
		await unlink(quarantinePath);
		return { ok: true, method: "unlink" };
	} catch (error) {
		const restoreError = await restoreQuarantinedSession(quarantinePath, input.sessionPath);
		return deletionFailure(restoreError ?? error);
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
				sourceLeafId: sessionManager.getLeafId(),
				metadata,
			}
		: undefined;
}

function hasMatchingBtwParent(ctx: ExtensionCommandContext, current: CurrentBtwSide): boolean {
	try {
		if (ctx.inspectSessionMetadata(current.metadata.parentSessionPath)?.id === current.metadata.parentSessionId) {
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
	const options = createBtwParentSwitchOptions(input.current.metadata, input.current.sessionDir, {
		...captureBtwSourceExpectation(input.ctx),
		sessionId: input.current.sessionId,
		leafId: input.current.sourceLeafId,
	});
	await input.ctx.switchSession(input.current.metadata.parentSessionPath, options);
}

export async function closeRetainedBtwSide(input: {
	ctx: ExtensionCommandContext;
	current: CurrentBtwSide | undefined;
	deleteSessionFile: (input: DeleteBtwSessionFileInput) => Promise<DeleteSessionFileResult>;
}): Promise<void> {
	const current = input.current;
	if (!current) {
		input.ctx.ui.notify("This is not a retained BTW session.", "warning");
		return;
	}
	if (!hasMatchingBtwParent(input.ctx, current)) return;
	await input.ctx.switchSession(current.metadata.parentSessionPath, {
		expectedSessionId: current.metadata.parentSessionId,
		expectedSource: {
			...captureBtwSourceExpectation(input.ctx),
			sessionId: current.sessionId,
			leafId: current.sourceLeafId,
		},
		sessionDir: current.sessionDir,
		withSession: async (nextCtx) => {
			let warning: string | undefined;
			try {
				if (nextCtx.inspectSessionMetadata(current.sessionPath)?.id !== current.sessionId) {
					warning = "The visible BTW session changed before deletion.";
				}
			} catch {
				warning = "The visible BTW session is no longer available for deletion.";
			}
			if (!warning) {
				const result = await input.deleteSessionFile({
					sessionPath: current.sessionPath,
					expectedSessionId: current.sessionId,
					inspectSessionId: (sessionPath) => nextCtx.inspectSessionMetadata(sessionPath)?.id,
				});
				if (!result.ok) {
					warning = `Failed to delete BTW session: ${result.error ?? "unknown error"}`;
				}
			}
			if (warning) nextCtx.ui.notify(warning, "warning");
			await createBtwParentSwitchOptions(current.metadata, current.sessionDir).withSession?.(nextCtx);
		},
	});
}
