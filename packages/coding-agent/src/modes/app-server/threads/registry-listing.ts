import type { SessionInfo } from "../../../core/session-manager.ts";
import type { WireThread } from "./registry.ts";

export function buildDiskThread(info: SessionInfo): WireThread {
	return {
		id: info.id,
		sessionId: info.id,
		sessionPath: info.path,
		cwd: info.cwd,
		createdAt: info.created.toISOString(),
		updatedAt: info.modified.toISOString(),
		status: { type: "notLoaded" },
		preview: info.firstMessage && info.firstMessage !== "(no messages)" ? info.firstMessage : null,
		name: info.name ?? null,
	};
}

export function compareThreads(left: WireThread, right: WireThread): number {
	const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
	if (updated !== 0) {
		return updated;
	}
	return left.id.localeCompare(right.id);
}

export function encodeCursor(offset: number): string {
	return Buffer.from(String(offset), "utf8").toString("base64");
}

export function decodeCursor(cursor: string | null | undefined): number {
	if (!cursor) {
		return 0;
	}
	const offset = Number.parseInt(Buffer.from(cursor, "base64").toString("utf8"), 10);
	return Number.isFinite(offset) && offset >= 0 ? offset : 0;
}
