import type { ThreadRollbackResponse } from "../protocol/index.ts";
import type { MethodRegistry, RpcRequest } from "../rpc/registry.ts";
import { type ThreadEntry, ThreadNotFoundError, type ThreadRegistry } from "./registry.ts";
import type { TurnLog } from "./turn-log.ts";
import { invalidRequest } from "./turn-runtime.ts";
import { buildWireThread, turnsForEntry } from "./wire-thread.ts";

const ROLLBACK_ENTRY_TYPE = "senpi.app-server.rollback";

export function registerThreadRollbackHandler(
	registry: MethodRegistry,
	threads: ThreadRegistry,
	turnLog: TurnLog,
): void {
	registry.register("thread/rollback", {
		scope: "thread",
		handler: async ({ request }) => rollbackThread(request, threads, turnLog),
	});
}

async function rollbackThread(
	request: RpcRequest,
	threads: ThreadRegistry,
	turnLog: TurnLog,
): Promise<ThreadRollbackResponse> {
	const params = rollbackParams(request.params);
	let entry: ThreadEntry;
	try {
		entry = await threads.resumeThread(params.threadId);
	} catch (error) {
		if (error instanceof ThreadNotFoundError) {
			throw invalidRequest(`thread not found: ${params.threadId}`);
		}
		throw error;
	}
	if (entry.activeTurn) {
		throw invalidRequest(`cannot roll back thread ${params.threadId} with an active turn`);
	}

	const turns = turnsForEntry(entry, turnLog);
	const firstRemoved = turns.at(-params.numTurns);
	if (!firstRemoved) {
		throw invalidRequest(`cannot roll back ${params.numTurns} turns from a thread with ${turns.length} turns`);
	}

	const sessionManager = entry.session.sessionManager;
	if (firstRemoved.rollbackLeafId === null) {
		sessionManager.resetLeaf();
	} else {
		sessionManager.branch(firstRemoved.rollbackLeafId);
	}
	if (turnLog.readTurns(entry.id).length > 0) {
		turnLog.rollbackTurns(entry.id, params.numTurns);
	}
	sessionManager.appendCustomEntry(ROLLBACK_ENTRY_TYPE, { numTurns: params.numTurns });
	entry.updatedAt = new Date().toISOString();

	return { thread: await buildWireThread(entry, turnLog, true) };
}

function rollbackParams(value: unknown): { readonly threadId: string; readonly numTurns: number } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw invalidRequest("thread/rollback params must be an object");
	}
	const threadId = Reflect.get(value, "threadId");
	if (typeof threadId !== "string" || threadId.length === 0) {
		throw invalidRequest("threadId is required");
	}
	const numTurns = Reflect.get(value, "numTurns");
	if (typeof numTurns !== "number" || !Number.isInteger(numTurns) || numTurns < 1) {
		throw invalidRequest("numTurns must be an integer greater than or equal to 1");
	}
	return { threadId, numTurns };
}
