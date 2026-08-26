import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { type AuthenticatedAttemptInput, queryWithAuthLane } from "./auth-lane.ts";
import { buildPromptBlocks } from "./prompt-bridge.ts";
import { dedupeUltraworkBlocks, serializedPayloadBytes } from "./prompt-directive-dedupe.ts";
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
import { bindingFromEntry, getBinding, reattachSession } from "./session-reattach.ts";
import {
	type ClaudeSdkOauthSessionEntry,
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

	const flattenResult = flatten
		? dedupeUltraworkBlocks(buildPromptBlocks(input.context, input.customToolNameToSdk, input.toolWatchNote))
		: undefined;
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
		env: input.streamOptions.env,
		signal: input.streamOptions.signal,
		sessionId: input.streamOptions.affinitySessionId ?? input.streamOptions.sessionId,
		pinnedAccount: input.pinnedAccount,
		buildOptions: input.buildOptions,
		createAttempt: (auth) => createResidentAttempt(input, auth),
	});
}
