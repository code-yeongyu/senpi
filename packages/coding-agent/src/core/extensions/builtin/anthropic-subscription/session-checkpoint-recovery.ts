import type { AnthropicSubscriptionAuthLane } from "./options.ts";
import type { Options, SessionMessage } from "./sdk-boundary.ts";
import { getSdkBoundary } from "./sdk-boundary.ts";
import { logContinuityEvent } from "./session-observability.ts";
import { type ContinuityBinding, reattachSession } from "./session-reattach.ts";
import type { AnthropicSubscriptionSessionEntry } from "./session-registry.ts";
import { RESUME_MESSAGE_MISSING } from "./session-turn-attempt.ts";

/** Each recovery spawns a Claude Code subprocess; a lineage this damaged cold-seeds instead. */
const MAX_CHECKPOINT_RECOVERIES = 3;

type CheckpointLookup = {
	binding: ContinuityBinding;
	currentHashes: readonly string[];
	cwd: string | undefined;
	authLane: AnthropicSubscriptionAuthLane;
};

/**
 * The newest mapped boundary strictly before `binding.sentCount` that lies inside the
 * hash-proven prefix AND exists in the SDK transcript of the same session as a top-level
 * assistant. Never guesses the transcript's latest assistant: only boundaries this
 * lineage mapped are candidates. The config-dir lane (per-account transcript roots) and
 * an unreadable or foreign transcript fail closed (senpi#1973).
 */
export async function earlierVerifiedCheckpoint(input: CheckpointLookup): Promise<ContinuityBinding | undefined> {
	const { binding, currentHashes } = input;
	if (input.cwd === undefined || input.authLane === "config-dir") return undefined;
	const candidates = (binding.assistantUuidByIndex ?? [])
		.filter(
			([index]) =>
				index >= 1 &&
				index < binding.sentCount &&
				index <= binding.sentHashes.length &&
				index <= currentHashes.length &&
				binding.sentHashes.slice(0, index).every((hash, offset) => hash === currentHashes[offset]),
		)
		.sort(([left], [right]) => right - left);
	if (candidates.length === 0) return undefined;
	let messages: SessionMessage[];
	try {
		messages = await getSdkBoundary().getSessionMessages(binding.sdkSessionId, { dir: input.cwd });
	} catch (error) {
		if (error instanceof Error) return undefined;
		throw error;
	}
	if (messages.some((message) => message.session_id !== binding.sdkSessionId)) return undefined;
	const available = new Set(
		messages
			.filter((message) => message.type === "assistant" && message.parent_tool_use_id === null)
			.map((message) => message.uuid),
	);
	const candidate = candidates.find(([, uuid]) => available.has(uuid));
	if (!candidate) return undefined;
	const [sentCount, lastAssistantUuid] = candidate;
	return {
		...binding,
		sentCount,
		sentHashes: currentHashes.slice(0, sentCount),
		lastAssistantUuid,
		assistantUuidByIndex: (binding.assistantUuidByIndex ?? []).filter(([index]) => index <= sentCount),
	};
}

export type RecoveringReattachInput = {
	binding: ContinuityBinding;
	atUuid?: string;
	options: Options;
	signal?: AbortSignal;
	currentHashes: readonly string[];
	authLane: AnthropicSubscriptionAuthLane;
};

/**
 * Reattaches at the decided boundary. When Claude Code rejects the fork point as absent
 * from its transcript, forks at the next earlier verified boundary instead of re-sending
 * the whole conversation; every retry strictly lowers the boundary index. Any other
 * failure, an abort, no verified candidate, or the attempt cap rethrows so the caller
 * still reports the fallback.
 */
export async function reattachRecoveringCheckpoint(
	input: RecoveringReattachInput,
): Promise<{ entry: AnthropicSubscriptionSessionEntry; from: number }> {
	let binding = input.binding;
	let atUuid = input.atUuid;
	for (let recovered = 0; ; recovered += 1) {
		try {
			const entry = await reattachSession({
				binding,
				options: input.options,
				...(atUuid ? { atUuid } : {}),
				...(input.signal ? { signal: input.signal } : {}),
			});
			return { entry, from: binding.sentCount };
		} catch (error) {
			if (input.signal?.aborted || recovered >= MAX_CHECKPOINT_RECOVERIES) throw error;
			if (!(error instanceof Error) || !RESUME_MESSAGE_MISSING.test(error.message)) throw error;
			const earlier = await earlierVerifiedCheckpoint({
				binding,
				currentHashes: input.currentHashes,
				cwd: input.options.cwd,
				authLane: input.authLane,
			});
			if (!earlier?.lastAssistantUuid) throw error;
			logContinuityEvent("claude_sdk_oauth_checkpoint_recovered", {
				rejectedIndex: binding.sentCount,
				recoveredIndex: earlier.sentCount,
			});
			binding = earlier;
			atUuid = earlier.lastAssistantUuid;
		}
	}
}
