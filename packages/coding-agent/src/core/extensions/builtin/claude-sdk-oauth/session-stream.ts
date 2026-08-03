import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { type AuthenticatedAttemptInput, queryWithAuthLane } from "./auth-lane.ts";
import { BoundedAsyncQueue, SESSION_STREAM_QUEUE_CAPACITY } from "./bounded-queue.ts";
import { buildPromptBlocks } from "./prompt-bridge.ts";
import type { SDKMessage, SDKUserMessage } from "./sdk-boundary.ts";
import { getSdkBoundary } from "./sdk-boundary.ts";
import { type ContinuityDecision, decideNativeContinuity } from "./session-continuity.ts";
import {
	type ContinuityObservation,
	consumePendingCloseCause,
	emitContinuityObservation,
	observeSessionSyncDecision,
	sanitizeTerminalFailure,
	stageContinuityDecision,
} from "./session-observability.ts";
import { bindingFromEntry, getBinding, reattachSession, rememberBinding } from "./session-reattach.ts";
import {
	type ClaudeSdkOauthSessionEntry,
	closeSession,
	getOrCreateSession,
	getSession,
	isCurrentGeneration,
	isIdleExpired,
	sessionRegistry,
} from "./session-registry.ts";
import { submitSessionTurn } from "./session-registry-pump.ts";
import {
	buildDeltaPromptBlocks,
	configFingerprint,
	recordSyncedStream,
	sentHashesForEntry,
	sentMessageHashes,
	sentMessages,
} from "./session-sync.ts";
import type { ClaudeSdkOauthProviderSettings } from "./settings.ts";

export type ResidentSessionStreamInput = {
	model: Model<Api>;
	context: Context;
	streamOptions: SimpleStreamOptions;
	providerSettings: ClaudeSdkOauthProviderSettings;
	pinnedAccount?: string;
	buildOptions: Parameters<typeof queryWithAuthLane>[0]["buildOptions"];
	customToolNameToSdk: ReadonlyMap<string, string>;
	toolWatchNote?: string;
	onResumeFallback: (error: unknown) => void;
	onContinuityDecision?: (observation: ContinuityObservation) => void;
};

function userMessage(content: SDKUserMessage["message"]["content"]): SDKUserMessage["message"] {
	return { role: "user", content } as SDKUserMessage["message"];
}

function successfulTurn(messages: readonly SDKMessage[]): boolean {
	return messages.some((message) => message.type === "result" && message.subtype === "success");
}

function recordAssistantUuid(entry: ClaudeSdkOauthSessionEntry, sentCount: number, message: SDKMessage): void {
	if (message.type === "assistant" && message.parent_tool_use_id === null) {
		entry.assistantUuidByIndex.set(sentCount, message.uuid);
	}
}

function turnAttempt(
	entry: ClaudeSdkOauthSessionEntry,
	message: SDKUserMessage["message"],
	hashes: readonly string[],
	signal: AbortSignal | undefined,
	staged: ReturnType<typeof stageContinuityDecision>,
) {
	const generation = entry.generation;
	return {
		messages: (async function* (): AsyncGenerator<SDKMessage> {
			const queue = new BoundedAsyncQueue<SDKMessage>(SESSION_STREAM_QUEUE_CAPACITY);
			const completion = submitSessionTurn(sessionRegistry, entry, {
				message,
				signal,
				onMessage: (sdkMessage) => {
					recordAssistantUuid(entry, hashes.length, sdkMessage);
					queue.push(sdkMessage);
				},
			});
			void completion.then(
				() => queue.close(),
				(error: unknown) => queue.fail(error),
			);
			try {
				for await (const sdkMessage of queue) yield sdkMessage;
				const turn = await completion;
				if (!turn.aborted && successfulTurn(turn.messages)) {
					recordSyncedStream(entry, hashes);
					rememberBinding(bindingFromEntry(entry, hashes));
				}
			} finally {
				// Every admitted turn reports exactly one decision, including one that
				// ended by abort or interrupt failure.
				staged.emit();
			}
		})(),
		discard: (): void => {
			if (isCurrentGeneration(entry.senpiSessionId, generation))
				closeSession(entry.senpiSessionId, "attempt_discarded");
		},
	};
}

const OBSERVED_KIND: Record<ContinuityDecision["kind"], "incremental" | "resume" | "cold-seed"> = {
	delta: "incremental",
	reattach: "resume",
	fork: "resume",
	flatten: "cold-seed",
	bootstrap: "cold-seed",
};

function entrySnapshot(entry: ClaudeSdkOauthSessionEntry, hashes: readonly string[]) {
	return {
		sdkSessionId: entry.sdkSessionId,
		accountName: entry.accountName,
		modelId: entry.modelId,
		systemPromptHash: entry.systemPromptHash,
		toolsetHash: entry.toolsetHash,
		sentCount: entry.sentCount,
		sentHashes: hashes.slice(0, entry.sentCount),
		lastAssistantUuid: entry.assistantUuidByIndex.get(entry.sentCount) ?? null,
		assistantUuidByIndex: entry.assistantUuidByIndex,
		pendingForkReason: entry.pendingForkReason,
		taintedReason: entry.taintedReason,
	};
}

async function createResidentAttempt(
	input: ResidentSessionStreamInput,
	auth: AuthenticatedAttemptInput,
): Promise<ReturnType<typeof turnAttempt>> {
	const sessionId = input.streamOptions.sessionId!;
	const messages = sentMessages(input.context);
	const hashes = sentMessageHashes(messages);
	const existing = getSession(sessionId);
	const fingerprint = configFingerprint(auth.options, input.context, auth.authLane, auth.accountName);
	const residentHashes = existing ? (sentHashesForEntry(existing) ?? hashes) : hashes;
	const decision = decideNativeContinuity({
		entry: existing ? entrySnapshot(existing, residentHashes) : undefined,
		binding: getBinding(sessionId),
		currentHashes: hashes,
		accountName: auth.accountName,
		modelId: input.model.id,
		fingerprint,
		transcriptAvailable: true,
		idleExpired: existing ? isIdleExpired(existing) : false,
	});
	const firstTurn = existing === undefined && getBinding(sessionId) === undefined && hashes.length <= 1;
	let observedReason =
		"reason" in decision ? decision.reason : decision.kind === "bootstrap" ? "registry_miss" : undefined;
	let observedKind: "incremental" | "resume" | "cold-seed" = OBSERVED_KIND[decision.kind];
	let entry: ClaudeSdkOauthSessionEntry;
	let from = 0;
	let flatten = decision.kind === "flatten" || decision.kind === "bootstrap";

	if (decision.kind === "delta" && existing) {
		entry = existing;
		from = decision.from;
	} else if (decision.kind === "reattach" || decision.kind === "fork") {
		const source = getBinding(sessionId) ?? (existing ? bindingFromEntry(existing, residentHashes) : undefined);
		const binding = source
			? {
					...source,
					sentCount: decision.from,
					sentHashes: source.sentHashes.slice(0, decision.from),
					assistantUuidByIndex: (source.assistantUuidByIndex ?? []).filter(([index]) => index <= decision.from),
					...(decision.kind === "fork" ? { lastAssistantUuid: decision.atUuid } : {}),
				}
			: undefined;
		try {
			if (!binding) throw new Error("Claude SDK OAuth continuity binding is unavailable");
			entry = await reattachSession({
				binding,
				options: auth.options,
				...(decision.kind === "fork" ? { atUuid: decision.atUuid } : {}),
				...(input.streamOptions.signal ? { signal: input.streamOptions.signal } : {}),
			});
			from = decision.from;
		} catch (error) {
			if (input.streamOptions.signal?.aborted) throw error;
			input.onResumeFallback(error);
			observedKind = "cold-seed";
			observedReason = "resume_initialization_failed";
			flatten = true;
			entry = getOrCreateSession({
				senpiSessionId: sessionId,
				accountName: auth.accountName,
				modelId: input.model.id,
				...fingerprint,
				options: auth.options,
			});
		}
	} else {
		if (existing) closeSession(sessionId, observedReason ?? "registry_miss");
		entry = getOrCreateSession({
			senpiSessionId: sessionId,
			accountName: auth.accountName,
			modelId: input.model.id,
			...fingerprint,
			options: auth.options,
		});
	}

	const blocks = flatten
		? buildPromptBlocks(input.context, input.customToolNameToSdk, input.toolWatchNote)
		: buildDeltaPromptBlocks(messages.slice(from), input.customToolNameToSdk);
	const staged = stageContinuityDecision(
		observeSessionSyncDecision({
			kind: observedKind,
			reason: observedReason,
			deltaMessages: flatten ? hashes.length : hashes.length - from,
			firstTurn,
			senpiSessionId: sessionId,
		}),
		input.onContinuityDecision,
		// The pending close cause is consumed only when the staged observation
		// actually emits (attempt retained) — a discarded attempt leaves the
		// cause pending for the next admission.
		() => consumePendingCloseCause(sessionId),
	);
	return turnAttempt(entry, userMessage(blocks), hashes, input.streamOptions.signal, staged);
}

export async function* residentSessionMessages(input: ResidentSessionStreamInput): AsyncGenerator<SDKMessage> {
	try {
		yield* residentAuthLaneMessages(input);
	} catch (error) {
		// Every attempt failed: the turn yields exactly one terminal observation.
		emitContinuityObservation(
			{ kind: "flatten", reason: sanitizeTerminalFailure(error) },
			input.onContinuityDecision,
		);
		throw error;
	}
}

function residentAuthLaneMessages(input: ResidentSessionStreamInput): AsyncIterable<SDKMessage> {
	return queryWithAuthLane({
		prompt: "",
		query: getSdkBoundary().query,
		providerSettings: input.providerSettings,
		sessionId: input.streamOptions.affinitySessionId ?? input.streamOptions.sessionId,
		pinnedAccount: input.pinnedAccount,
		buildOptions: input.buildOptions,
		createAttempt: (auth) => createResidentAttempt(input, auth),
	});
}
