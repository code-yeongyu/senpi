import { randomUUID } from "node:crypto";
import { link, rename, stat, unlink } from "node:fs/promises";
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

export interface DeleteBtwSessionFileOperations {
	link(source: string, destination: string): Promise<void>;
	rename(source: string, destination: string): Promise<void>;
	stat(path: string): Promise<{ dev: bigint | number; ino: bigint | number }>;
	unlink(path: string): Promise<void>;
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

async function removeClaim(path: string, operations: DeleteBtwSessionFileOperations): Promise<string | undefined> {
	try {
		await operations.unlink(path);
		return undefined;
	} catch (error) {
		if (isFileError(error, "ENOENT")) return undefined;
		return error instanceof Error ? error.message : String(error);
	}
}

async function restoreMovedSession(
	movedPath: string,
	sessionPath: string,
	operations: DeleteBtwSessionFileOperations,
): Promise<{ error?: string; recoveryPaths: string[] }> {
	const recoveryPaths: string[] = [];
	for (let attempt = 0; attempt < 32; attempt++) {
		try {
			await operations.link(movedPath, sessionPath);
			await operations.unlink(movedPath);
			return { recoveryPaths };
		} catch (error) {
			if (!isFileError(error, "EEXIST")) {
				return {
					error: `Failed to restore the moved BTW session: ${error instanceof Error ? error.message : String(error)}`,
					recoveryPaths,
				};
			}
		}
		const recoveryPath = `${sessionPath}.btw-recovery-${randomUUID()}`;
		try {
			await operations.rename(sessionPath, recoveryPath);
			recoveryPaths.push(recoveryPath);
		} catch (error) {
			if (isFileError(error, "ENOENT")) continue;
			return {
				error: `Failed to preserve a concurrent session write: ${error instanceof Error ? error.message : String(error)}`,
				recoveryPaths,
			};
		}
	}
	return {
		error: `Could not restore the moved BTW session after repeated path recreation; preserved it at ${movedPath}`,
		recoveryPaths,
	};
}

function sameFileIdentity(
	left: { dev: bigint | number; ino: bigint | number },
	right: { dev: bigint | number; ino: bigint | number },
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

const defaultDeleteOperations: DeleteBtwSessionFileOperations = {
	link,
	rename,
	stat: (path) => stat(path, { bigint: true }),
	unlink,
};

export async function deleteBtwSessionFile(
	input: DeleteBtwSessionFileInput,
	operations: DeleteBtwSessionFileOperations = defaultDeleteOperations,
): Promise<DeleteSessionFileResult> {
	const changedMessage = "The visible BTW session changed before deletion.";
	const claimPath = `${input.sessionPath}.btw-claim-${randomUUID()}`;
	try {
		await operations.link(input.sessionPath, claimPath);
	} catch (error) {
		if (isFileError(error, "ENOENT")) return { ok: true, method: "unlink" };
		return deletionFailure(error);
	}

	let claimIdentity: { dev: bigint | number; ino: bigint | number };
	try {
		if (input.inspectSessionId(claimPath) !== input.expectedSessionId) {
			const cleanupError = await removeClaim(claimPath, operations);
			return deletionFailure(
				cleanupError ? `${changedMessage} Claim cleanup failed: ${cleanupError}` : changedMessage,
			);
		}
		claimIdentity = await operations.stat(claimPath);
	} catch (error) {
		const cleanupError = await removeClaim(claimPath, operations);
		return deletionFailure(
			cleanupError ? `The claimed BTW session could not be validated. Claim cleanup failed: ${cleanupError}` : error,
		);
	}

	const movedPath = `${input.sessionPath}.btw-delete-${randomUUID()}`;
	try {
		await operations.rename(input.sessionPath, movedPath);
	} catch (error) {
		const cleanupError = await removeClaim(claimPath, operations);
		if (isFileError(error, "ENOENT") && !cleanupError) return { ok: true, method: "unlink" };
		return deletionFailure(cleanupError ? `${String(error)}; claim cleanup failed: ${cleanupError}` : error);
	}

	let movedIdentity: { dev: bigint | number; ino: bigint | number };
	try {
		movedIdentity = await operations.stat(movedPath);
	} catch (error) {
		const restore = await restoreMovedSession(movedPath, input.sessionPath, operations);
		const cleanupError = await removeClaim(claimPath, operations);
		const details = [
			error instanceof Error ? error.message : String(error),
			restore.error,
			restore.recoveryPaths.length > 0
				? `Concurrent path data was preserved at ${restore.recoveryPaths.join(", ")}.`
				: undefined,
			cleanupError ? `Claim cleanup failed: ${cleanupError}` : undefined,
		].filter((part): part is string => part !== undefined);
		return deletionFailure(details.join(" "));
	}

	if (!sameFileIdentity(claimIdentity, movedIdentity)) {
		const restore = await restoreMovedSession(movedPath, input.sessionPath, operations);
		const cleanupError = await removeClaim(claimPath, operations);
		const details = [
			changedMessage,
			restore.error,
			restore.recoveryPaths.length > 0
				? `Concurrent path data was preserved at ${restore.recoveryPaths.join(", ")}.`
				: undefined,
			cleanupError ? `Claim cleanup failed: ${cleanupError}` : undefined,
		].filter((part): part is string => part !== undefined);
		return deletionFailure(details.join(" "));
	}

	try {
		await operations.unlink(movedPath);
		await operations.unlink(claimPath);
		return { ok: true, method: "unlink" };
	} catch (error) {
		return deletionFailure(error);
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
