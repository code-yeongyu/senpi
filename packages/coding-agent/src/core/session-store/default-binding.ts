import { dirname } from "node:path";
import { isBunRuntime } from "../../config.ts";
import type { SessionManager } from "../session-manager.ts";
import { loadDefaultSessionStore } from "./default-store.lazy.ts";
import { nodeHostRefusal, nodeJsonlHatchEnabled } from "./node-guard.ts";

/** "jsonl" keeps the legacy JSONL store on Bun: a test-only, in-process choice (no environment variable reaches it). */
export type SessionStoreChoice = "jsonl";

/**
 * S21b: on Bun, a persisted session is bound to its durable store (one medium per session under the agent dir) before
 * anything else writes to it. On Node a persisted session opens only under the JSONL developer hatch.
 */
export async function bindDefaultSessionStore(
	sessionManager: SessionManager,
	options: { readonly agentDir: string; readonly sessionStore?: SessionStoreChoice },
): Promise<void> {
	if (options.sessionStore === "jsonl") return;
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionManager.isPersisted() || sessionFile === undefined) return;
	if (!isBunRuntime) {
		// K9.a: the durable store does not exist on Node. The developer hatch keeps the legacy JSONL store; otherwise
		// the open fails with the same steering message the CLI prints.
		if (nodeJsonlHatchEnabled()) return;
		throw nodeHostRefusal();
	}
	const { openDefaultSessionStore } = await loadDefaultSessionStore();
	const bound = await openDefaultSessionStore({
		agentDir: options.agentDir,
		sessionDir: dirname(sessionFile),
		sessionId: sessionManager.getSessionId(),
	});
	await sessionManager.bindDurableStore(bound);
}
