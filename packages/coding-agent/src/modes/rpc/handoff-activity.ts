import { isSessionBusySnapshot, type SessionActivitySnapshot } from "../../core/session-activity.ts";

/** Handoff preserves turns and requests, but durable wake sources resume when the file is reopened. */
export function isHandoffBusy(snapshot: SessionActivitySnapshot): boolean {
	return isSessionBusySnapshot({ ...snapshot, hasActiveWakeSource: false });
}
