import { unlink } from "node:fs/promises";
import type { ReadonlySessionManager } from "../../../session-manager.ts";
import type { ExtensionCommandContext } from "../../types.ts";
import { type BtwSideMetadata, readBtwSideMetadata } from "./session-catalog.ts";

export interface CurrentBtwSide {
	sessionPath: string;
	metadata: BtwSideMetadata;
}

export interface DeleteSessionFileResult {
	ok: boolean;
	method: "trash" | "unlink";
	error?: string;
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
	return metadata ? { sessionPath, metadata } : undefined;
}

export async function returnToBtwParent(input: {
	ctx: ExtensionCommandContext;
	current: CurrentBtwSide | undefined;
}): Promise<void> {
	if (!input.current) {
		input.ctx.ui.notify("This is not a retained BTW session.", "warning");
		return;
	}
	await input.ctx.switchSession(input.current.metadata.parentSessionPath);
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
	await input.ctx.switchSession(current.metadata.parentSessionPath, {
		withSession: async (nextCtx) => {
			const result = await input.deleteSessionFile(current.sessionPath);
			if (result.ok) return;
			nextCtx.ui.notify(`Failed to delete BTW session: ${result.error ?? "unknown error"}`, "warning");
		},
	});
}
