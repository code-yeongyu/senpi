import { randomUUID } from "node:crypto";
import type { AgentAbortSource } from "../../core/agent-abort-provenance.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { describeUsageLimitEntry } from "../../core/retry-fallback/usage-limit.ts";
import { currentResponseByteBudget, DEFAULT_ENTRY_PAGE_BYTES } from "./get-entries-page.ts";
import { buildRpcSessionState } from "./rpc-session-state.ts";
import type { RpcSnapshot } from "./snapshot-types.ts";

type SnapshotRequest = { readonly tail?: unknown; readonly maxBytes?: unknown };

/** Capture and mark on the source loop, before any response-writing await. */
export function getSnapshot(
	session: AgentSession,
	request: SnapshotRequest,
	cursor: { readonly enqueue: (markerId: string) => void; readonly lastAbortSource?: AgentAbortSource },
): { readonly data: RpcSnapshot } | { readonly error: string } {
	const tail = request.tail === undefined ? 100 : request.tail;
	const maxBytes = request.maxBytes === undefined ? DEFAULT_ENTRY_PAGE_BYTES : request.maxBytes;
	if (typeof tail !== "number" || !Number.isSafeInteger(tail) || tail < 0)
		return { error: "tail must be a non-negative integer" };
	if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes <= 0)
		return { error: "maxBytes must be a positive integer" };
	const state = buildRpcSessionState(session, cursor.lastAbortSource);
	const history = session.sessionManager.getEntries();
	const entries = [];
	let bytes = 2;
	for (let i = history.length - 1; i >= 0 && entries.length < tail; i--) {
		const entry = history[i];
		if (entry === undefined) break;
		const projected = describeUsageLimitEntry(entry);
		const size = Buffer.byteLength(JSON.stringify(projected)) + (entries.length > 0 ? 1 : 0);
		if (bytes + size > Math.min(maxBytes, currentResponseByteBudget())) break;
		entries.push(projected);
		bytes += size;
	}
	entries.reverse();
	const history_truncated = entries.length < history.length;
	const markerId = randomUUID();
	// Some state fields and entry payloads are live references: detach them before yielding, too.
	const data = structuredClone({
		state,
		entries,
		history_truncated,
		next_before: history_truncated ? (entries[0]?.id ?? null) : null,
		markerId,
	});
	session.releaseFullHistoryView();
	cursor.enqueue(markerId);
	return { data };
}
