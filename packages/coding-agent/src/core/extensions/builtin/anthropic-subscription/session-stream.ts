import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { type AuthenticatedAttemptInput, queryWithAuthLane } from "./auth-lane.ts";
import { coldSeedCalibration, coldSeedOverflow, estimateColdSeedTokens } from "./cold-seed-budget.ts";
import { buildPromptBlocks } from "./prompt-bridge.ts";
import { dedupeUltraworkBlocks, serializedPayloadBytes } from "./prompt-directive-dedupe.ts";
import type { SDKMessage, SDKUserMessage } from "./sdk-boundary.ts";
import { getSdkBoundary } from "./sdk-boundary.ts";
import { reattachRecoveringCheckpoint } from "./session-checkpoint-recovery.ts";
import { type ContinuityDecision, decideNativeContinuity } from "./session-continuity.ts";
import {
	type ContinuityObservation,
	consumePendingCloseCause,
	emitContinuityObservation,
	observeSessionSyncDecision,
	sanitizeTerminalFailure,
	stageContinuityDecision,
} from "./session-observability.ts";
import { bindingFromEntry, bindingInvalidationReason, getBinding } from "./session-reattach.ts";
import {
	type AnthropicSubscriptionSessionEntry,
	closeSession,
	getOrCreateSession,
	getSession,
	isIdleExpired,
} from "./session-registry.ts";
import { admitRestoredBinding } from "./session-restored-admission.ts";
import {
	buildDeltaPromptBlocks,
	configFingerprint,
	sentHashesForEntry,
	sentMessageHashes,
	sentMessages,
} from "./session-sync.ts";
import { createSessionTurnAttempt } from "./session-turn-attempt.ts";
import type { AnthropicSubscriptionProviderSettings } from "./settings.ts";

export type ResidentSessionStreamInput = {
	model: Model<Api>;
	context: Context;
	streamOptions: SimpleStreamOptions;
	providerSettings: AnthropicSubscriptionProviderSettings;
	pinnedAccount?: string;
	buildOptions: Parameters<typeof queryWithAuthLane>[0]["buildOptions"];
	customToolNameToSdk: ReadonlyMap<string, string>;
	toolWatchNote?: string;
	onResumeFallback: (error: unknown) => void;
	onContinuityDecision?: (observation: ContinuityObservation) => void;
	/** Called once per attempt, before dispatch, with whether it re-sends the whole history and that re-send's bytes/4 estimate. */
	onDispatchShape?: (coldSeed: boolean, estimatedTokens?: number) => void;
};

function userMessage(content: SDKUserMessage["message"]["content"]): SDKUserMessage["message"] {
	return { role: "user", content } as SDKUserMessage["message"];
}

const OBSERVED_KIND: Record<ContinuityDecision["kind"], "incremental" | "resume" | "cold-seed"> = {
	delta: "incremental",
	reattach: "resume",
	fork: "resume",
	flatten: "cold-seed",
	bootstrap: "cold-seed",
};

function contextHasPriorAssistantMessage(context: Context): boolean {
	return context.messages.some((message) => message.role === "assistant");
}

function entrySnapshot(entry: AnthropicSubscriptionSessionEntry, hashes: readonly string[]) {
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
		credentialDigest: entry.credentialDigest,
	};
}

async function createResidentAttempt(
	input: ResidentSessionStreamInput,
	auth: AuthenticatedAttemptInput,
): Promise<ReturnType<typeof createSessionTurnAttempt>> {
	const sessionId = input.streamOptions.sessionId!;
	const messages = sentMessages(input.context);
	const hashes = sentMessageHashes(messages);
	const existing = getSession(sessionId);
	const fingerprint = configFingerprint(auth.options, input.context, auth.authLane, auth.accountName);
	const residentHashes = existing ? (sentHashesForEntry(existing) ?? hashes) : hashes;
	const { binding, transcriptAvailable } = await admitRestoredBinding(sessionId, auth.options.cwd, auth.authLane);
	const decision = decideNativeContinuity({
		entry: existing ? entrySnapshot(existing, residentHashes) : undefined,
		binding,
		currentHashes: hashes,
		accountName: auth.accountName,
		modelId: input.model.id,
		fingerprint,
		transcriptAvailable,
		crossAccountResumeSupported: auth.authLane !== "config-dir",
		idleExpired: existing ? isIdleExpired(existing) : false,
		invalidationReason: bindingInvalidationReason(sessionId),
		credentialDigest: auth.credentialDigest,
	});
	const firstTurn =
		existing === undefined && getBinding(sessionId) === undefined && !contextHasPriorAssistantMessage(input.context);
	let observedReason =
		"reason" in decision ? decision.reason : decision.kind === "bootstrap" ? "registry_miss" : undefined;
	let observedKind: "incremental" | "resume" | "cold-seed" = OBSERVED_KIND[decision.kind];
	let entry: AnthropicSubscriptionSessionEntry;
	let from = 0;
	let flatten = decision.kind === "flatten" || decision.kind === "bootstrap";

	if (decision.kind === "delta" && existing) {
		entry = existing;
		from = decision.from;
	} else if (decision.kind === "reattach" || decision.kind === "fork") {
		const source = getBinding(sessionId) ?? (existing ? bindingFromEntry(existing, residentHashes) : undefined);
		const binding = source
			? (({ sentPrefixHash: _persistedPrefix, ...rest }) => ({
					...rest,
					sentCount: decision.from,
					sentHashes: hashes.slice(0, decision.from),
					assistantUuidByIndex: (source.assistantUuidByIndex ?? []).filter(([index]) => index <= decision.from),
					accountName: auth.accountName,
					modelId: input.model.id,
					systemPromptHash: fingerprint.systemPromptHash,
					toolsetHash: fingerprint.toolsetHash,
					...(decision.kind === "fork" ? { lastAssistantUuid: decision.atUuid } : {}),
				}))(source)
			: undefined;
		try {
			if (!binding) throw new Error("Anthropic Subscription continuity binding is unavailable");
			({ entry, from } = await reattachRecoveringCheckpoint({
				binding,
				options: auth.options,
				...(decision.kind === "fork" ? { atUuid: decision.atUuid } : {}),
				...(input.streamOptions.signal ? { signal: input.streamOptions.signal } : {}),
				currentHashes: hashes,
				authLane: auth.authLane,
			}));
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
	// Every branch above either reuses a subprocess whose token matched (delta)
	// or spawned one with auth.options, so the entry now runs on this token.
	entry.credentialDigest = auth.credentialDigest;

	const flattenResult = flatten
		? dedupeUltraworkBlocks(buildPromptBlocks(input.context, input.customToolNameToSdk, input.toolWatchNote))
		: undefined;
	const estimatedTokens = flattenResult ? estimateColdSeedTokens(input.context, flattenResult.blocks) : undefined;
	input.onDispatchShape?.(flattenResult !== undefined, estimatedTokens);
	const overBudget =
		estimatedTokens !== undefined
			? coldSeedOverflow(input.model, estimatedTokens, coldSeedCalibration(sessionId))
			: undefined;
	if (overBudget) {
		// Never dispatch a re-send that cannot fit: the SDK cannot compact a single
		// exchange, so the overflow must reach senpi's own compaction instead. The
		// calibration learned from this session's earlier rejection sizes it the way
		// the API counts, so a compacted re-send that is still too long is refused
		// here instead of costing another round trip.
		closeSession(sessionId, "cold_seed_over_budget");
		throw overBudget;
	}
	const blocks = flattenResult
		? flattenResult.blocks
		: buildDeltaPromptBlocks(messages.slice(from), input.customToolNameToSdk);
	const payloadBytes = flattenResult ? serializedPayloadBytes(flattenResult.blocks) : undefined;
	const staged = stageContinuityDecision(
		observeSessionSyncDecision({
			kind: observedKind,
			reason: observedReason,
			deltaMessages: flatten ? hashes.length : hashes.length - from,
			firstTurn,
			senpiSessionId: sessionId,
			...(payloadBytes !== undefined ? { payloadBytes } : {}),
			...(flattenResult?.collapsedDirectives !== undefined
				? { collapsedDirectives: flattenResult.collapsedDirectives }
				: {}),
		}),
		sessionId,
		input.onContinuityDecision,
		// The pending close cause is consumed only when the staged observation
		// actually emits (attempt retained) — a discarded attempt leaves the
		// cause pending for the next admission.
		() => consumePendingCloseCause(sessionId),
	);
	return createSessionTurnAttempt(entry, userMessage(blocks), hashes, input.streamOptions.signal, staged);
}

export async function* residentSessionMessages(input: ResidentSessionStreamInput): AsyncGenerator<SDKMessage> {
	try {
		yield* residentAuthLaneMessages(input);
	} catch (error) {
		// Every attempt failed: the turn yields exactly one terminal observation. It is `failed`,
		// not `flatten`: nothing was re-sent, and the retry checkpoint still resumes the lineage.
		emitContinuityObservation(
			{ kind: "failed", reason: sanitizeTerminalFailure(error) },
			input.streamOptions.sessionId,
			input.onContinuityDecision,
		);
		throw error;
	}
}

function residentAuthLaneMessages(input: ResidentSessionStreamInput): AsyncIterable<SDKMessage> {
	const sessionId = input.streamOptions.sessionId;
	const preferredAccount =
		sessionId === undefined ? undefined : (getSession(sessionId)?.accountName ?? getBinding(sessionId)?.accountName);
	return queryWithAuthLane({
		prompt: "",
		query: getSdkBoundary().query,
		providerSettings: input.providerSettings,
		env: input.streamOptions.env,
		signal: input.streamOptions.signal,
		sessionId: input.streamOptions.affinitySessionId ?? input.streamOptions.sessionId,
		model: input.model.id,
		pinnedAccount: input.pinnedAccount,
		...(preferredAccount === undefined ? {} : { preferredAccount }),
		buildOptions: input.buildOptions,
		createAttempt: (auth) => createResidentAttempt(input, auth),
	});
}
