import type { ClaudeSdkOauthAuthLane } from "./options.ts";
import type { Options, SessionMessage } from "./sdk-boundary.ts";
import { getSdkBoundary, loadClaudeAgentSdk } from "./sdk-boundary.ts";
import { type ClaudeSdkOauthSessionEntry, closeSession, getOrCreateSession } from "./session-registry.ts";
import { recordSyncedStream } from "./session-sync.ts";

export type ContinuityBinding = {
	senpiSessionId: string;
	sdkSessionId: string;
	sentCount: number;
	sentHashes: readonly string[];
	sentPrefixHash?: string;
	/**
	 * False while the SDK has not yet acknowledged this session id (no init and
	 * no replay echo): continuity must never resume or fork such an id.
	 */
	sdkSessionIdConfirmed?: boolean;
	lastAssistantUuid: string | null;
	accountName: string;
	modelId: string;
	systemPromptHash: string;
	toolsetHash: string;
	/** Assistant boundaries kept as entries so a later fork still has a resume point. */
	assistantUuidByIndex?: readonly (readonly [number, string])[];
	/**
	 * Digest of the FULL sent stream an attempt pushed but never got answered
	 * (stream-start timeout abort/failure). Purely in-memory: it lets the SAME
	 * turn's retry fork at the pre-turn boundary instead of re-appending its user
	 * message to a lineage that already carries it. Never persisted — the sidecar
	 * schema is fixed at schemaVersion 1 and restart retries are out of scope.
	 */
	unansweredTurnDigest?: string;
};

export type ReattachInput = {
	binding: ContinuityBinding;
	options: Options;
	atUuid?: string;
	signal?: AbortSignal;
};

const bindings = new Map<string, ContinuityBinding>();

export type AbortOutcome = "keep" | "reattach";

function cloneBinding(binding: ContinuityBinding): ContinuityBinding {
	return {
		...binding,
		sentHashes: [...binding.sentHashes],
		assistantUuidByIndex: binding.assistantUuidByIndex?.map(([index, uuid]) => [index, uuid]),
	};
}

export function evaluateAbortOutcome(receipt: unknown): AbortOutcome {
	if (!receipt || typeof receipt !== "object") return "reattach";
	const queued = (receipt as { still_queued?: unknown }).still_queued;
	return Array.isArray(queued) && queued.length === 0 ? "keep" : "reattach";
}

export function rememberBinding(binding: ContinuityBinding): void {
	bindings.set(binding.senpiSessionId, cloneBinding(binding));
}

export function getBinding(senpiSessionId: string): ContinuityBinding | undefined {
	const binding = bindings.get(senpiSessionId);
	return binding ? cloneBinding(binding) : undefined;
}

export function forgetBinding(senpiSessionId: string): void {
	bindings.delete(senpiSessionId);
}

export function bindingFromEntry(
	entry: Pick<
		ClaudeSdkOauthSessionEntry,
		| "senpiSessionId"
		| "sdkSessionId"
		| "sentCount"
		| "accountName"
		| "modelId"
		| "systemPromptHash"
		| "toolsetHash"
		| "assistantUuidByIndex"
		| "sdkSessionIdConfirmed"
	>,
	sentHashes: readonly string[],
): ContinuityBinding {
	return {
		senpiSessionId: entry.senpiSessionId,
		sdkSessionId: entry.sdkSessionId,
		sdkSessionIdConfirmed: entry.sdkSessionIdConfirmed,
		sentCount: entry.sentCount,
		sentHashes: [...sentHashes],
		lastAssistantUuid: entry.assistantUuidByIndex.get(entry.sentCount) ?? null,
		assistantUuidByIndex: [...entry.assistantUuidByIndex.entries()],
		accountName: entry.accountName,
		modelId: entry.modelId,
		systemPromptHash: entry.systemPromptHash,
		toolsetHash: entry.toolsetHash,
	};
}

export async function verifyRestoredTranscript(
	binding: ContinuityBinding,
	cwd: string,
	authLane: ClaudeSdkOauthAuthLane,
): Promise<boolean> {
	if (authLane === "config-dir") return false;
	let messages: SessionMessage[];
	try {
		messages = await getSdkBoundary().getSessionMessages(binding.sdkSessionId, { dir: cwd });
	} catch (error) {
		if (error instanceof Error) return false;
		throw error;
	}
	if (messages.length === 0 || messages.some((message) => message.session_id !== binding.sdkSessionId)) {
		return false;
	}
	if (binding.lastAssistantUuid === null) return true;
	return messages.some(
		(message) =>
			message.type === "assistant" &&
			message.uuid === binding.lastAssistantUuid &&
			message.parent_tool_use_id === null,
	);
}

async function awaitInitialization(entry: ClaudeSdkOauthSessionEntry, signal?: AbortSignal): Promise<void> {
	const initialize = entry.query.initializationResult;
	if (!initialize) return;
	if (!signal) {
		await initialize.call(entry.query);
		return;
	}
	const aborted = new Promise<never>((_resolve, reject) => {
		const onAbort = (): void => {
			closeSession(entry.senpiSessionId, "resume_initialization_aborted");
			reject(new Error("Claude SDK OAuth reattach aborted"));
		};
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
	await Promise.race([initialize.call(entry.query), aborted]);
}

/**
 * A new query is not a new session: `resume` re-attaches to the existing lineage.
 * `sessionId` must stay absent unless forking, because the SDK rejects the pair
 * (sdk.d.ts:1805-1808) and would otherwise silently start an unrelated session.
 */
export async function reattachSession(input: ReattachInput): Promise<ClaudeSdkOauthSessionEntry> {
	// getOrCreateSession() reaches the synchronous SDK `query` through the
	// session-registry boundary - see sdk-boundary.lazy.ts.
	await loadClaudeAgentSdk();
	const { binding, atUuid } = input;
	closeSession(binding.senpiSessionId, "reattach");
	const entry = getOrCreateSession({
		senpiSessionId: binding.senpiSessionId,
		accountName: binding.accountName,
		modelId: binding.modelId,
		systemPromptHash: binding.systemPromptHash,
		toolsetHash: binding.toolsetHash,
		options: input.options,
		resume: atUuid ? { sdkSessionId: binding.sdkSessionId, atUuid } : { sdkSessionId: binding.sdkSessionId },
	});

	try {
		await awaitInitialization(entry, input.signal);
	} catch (error) {
		closeSession(binding.senpiSessionId, "resume_initialization_failed");
		throw error;
	}

	recordSyncedStream(entry, binding.sentHashes);
	for (const [index, uuid] of binding.assistantUuidByIndex ?? []) entry.assistantUuidByIndex.set(index, uuid);
	if (binding.lastAssistantUuid) entry.assistantUuidByIndex.set(binding.sentCount, binding.lastAssistantUuid);
	rememberBinding({ ...binding, sdkSessionId: entry.sdkSessionId });
	return entry;
}
