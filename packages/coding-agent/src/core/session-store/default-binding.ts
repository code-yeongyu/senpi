import { isBunRuntime } from "../../config.ts";
import type { SessionManager } from "../session-manager.ts";
import { loadDefaultSessionStore } from "./default-store.lazy.ts";

/** "jsonl" keeps the legacy JSONL store on Bun: a test-only, in-process choice (no environment variable reaches it). */
export type SessionStoreChoice = "jsonl";

/**
 * S21b: on Bun, a persisted session is bound to its durable store (one medium per session under the agent dir) before
 * anything else writes to it. Node is untouched here; S21b's Node guard decides what a Node process may open.
 */
export async function bindDefaultSessionStore(
	sessionManager: SessionManager,
	options: { readonly agentDir: string; readonly sessionStore?: SessionStoreChoice },
): Promise<void> {
	if (!isBunRuntime || options.sessionStore === "jsonl") return;
	if (!sessionManager.isPersisted() || sessionManager.getSessionFile() === undefined) return;
	const { openDefaultSessionStore } = await loadDefaultSessionStore();
	const bound = await openDefaultSessionStore({
		agentDir: options.agentDir,
		sessionId: sessionManager.getSessionId(),
	});
	await sessionManager.bindDurableStore(bound);
}
