/**
 * The one `get_entries` answer: a host connection and a terminal control endpoint both read history through it, so
 * the range rules (`since`, `before`), the forward (`limit`) and backward (`tail`, senpi#4267) pages and the byte
 * budget (senpi#3534) are the same on every surface.
 */
import type { AgentSession } from "../../core/agent-session.ts";
import { describeUsageLimitEntry } from "../../core/retry-fallback/usage-limit.ts";
import {
	currentResponseByteBudget,
	endEntryWalk,
	entryPageBounds,
	holdEntryWalk,
	pageEntries,
	pageEntriesFromEnd,
} from "./get-entries-page.ts";
import {
	RPC_ERROR_ENTRY_NOT_FOUND,
	RPC_ERROR_INVALID_ARGUMENT,
	RPC_ERROR_RESPONSE_TOO_LARGE,
	type RpcCommand,
	type RpcResponse,
} from "./rpc-types.ts";

type GetEntries = Extract<RpcCommand, { type: "get_entries" }>;

function refuse(id: string | undefined, message: string, errorCode: string): RpcResponse {
	return { id, type: "response", command: "get_entries", success: false, error: message, errorCode };
}

export function answerGetEntries(session: AgentSession, command: GetEntries): RpcResponse {
	const { id } = command;
	const sessionManager = session.sessionManager;
	let entries = sessionManager.getEntries();
	if (command.before !== undefined) {
		const beforeIndex = entries.findIndex((e) => e.id === command.before);
		if (beforeIndex === -1) return refuse(id, `Entry not found: ${command.before}`, RPC_ERROR_ENTRY_NOT_FOUND);
		entries = entries.slice(0, beforeIndex);
	}
	if (command.since !== undefined) {
		const sinceIndex = sessionManager.getEntries().findIndex((e) => e.id === command.since);
		if (sinceIndex === -1) return refuse(id, `Entry not found: ${command.since}`, RPC_ERROR_ENTRY_NOT_FOUND);
		entries = entries.slice(sinceIndex + 1);
	}
	const bounds = entryPageBounds(command);
	if (!bounds.ok) return refuse(id, bounds.message, RPC_ERROR_INVALID_ARGUMENT);
	const backward = bounds.tail !== undefined;
	const page = backward
		? pageEntriesFromEnd(entries, describeUsageLimitEntry, bounds)
		: pageEntries(entries, describeUsageLimitEntry, bounds);
	// A client walking pages asks again at once; holding the view until the last page spares each page a
	// full re-read of the file. The hold expires on its own, so a walk the client abandons on an idle
	// session does not pin the whole history; any other answer lets the view go now.
	if (bounds.paged && page.hasMore) holdEntryWalk(session, () => session.releaseFullHistoryView());
	else {
		endEntryWalk(session);
		session.releaseFullHistoryView();
	}
	const budget = currentResponseByteBudget();
	if (page.firstEntryBytes > budget) {
		const entry = backward ? entries.at(-1) : entries[0];
		return refuse(
			id,
			`Entry ${entry?.id ?? ""} alone is larger than one answer can carry (${budget} bytes), so it cannot be sent over RPC.`,
			RPC_ERROR_RESPONSE_TOO_LARGE,
		);
	}
	if (!bounds.paged && page.hasMore) {
		return refuse(
			id,
			`The session history is larger than one answer can carry (${budget} bytes). Read it in pages: pass limit or maxBytes, then since: nextSince until hasMore is false.`,
			RPC_ERROR_RESPONSE_TOO_LARGE,
		);
	}
	return {
		id,
		type: "response",
		command: "get_entries",
		success: true,
		data: {
			entries: page.entries,
			leafId: sessionManager.getLeafId(),
			...(bounds.paged ? { hasMore: page.hasMore } : {}),
			...("nextSince" in page && page.nextSince !== undefined ? { nextSince: page.nextSince } : {}),
			...("nextBefore" in page && page.nextBefore !== undefined ? { next_before: page.nextBefore } : {}),
		},
	};
}
