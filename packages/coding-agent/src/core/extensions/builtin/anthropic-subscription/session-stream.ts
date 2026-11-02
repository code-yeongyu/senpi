import { rmSync } from "node:fs";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { initializationOrAbort } from "./auth-attempt.ts";
import { type AuthenticatedAttemptInput, queryWithAuthLane } from "./auth-lane.ts";
import { coldSeedCalibration, coldSeedOverflow, estimateColdSeedTokens } from "./cold-seed-budget.ts";
import { buildColdSeedFrames, framesApply, seedConfigDir, withFlatFallbackOnce } from "./cold-seed-frames.ts";
import { loadHistoryTranscript } from "./history-transcript.lazy.ts";
import { buildPromptBlocks } from "./prompt-bridge.ts";
import { pinnedPromptCacheTtl } from "./prompt-cache-ttl.ts";
import { dedupeUltraworkBlocks, serializedPayloadBytes } from "./prompt-directive-dedupe.ts";
import type { SDKMessage, SDKUserMessage } from "./sdk-boundary.ts";
import { getSdkBoundary } from "./sdk-boundary.ts";
import { seatDigest } from "./seat-digest.ts";
import { reattachRecoveringCheckpoint } from "./session-checkpoint-recovery.ts";
import { type ContinuityDecision, decideNativeContinuity } from "./session-continuity.ts";
import {
	type ContinuityObservation,
	consumePendingCloseCause,
	emitContinuityObservation,
	observeSessionSyncDecision,
	recordPendingCloseCause,
	sanitizeTerminalFailure,
	stageContinuityDecision,
} from "./session-observability.ts";
import { bindingFromEntry, bindingInvalidationReason, forgetBinding, getBinding } from "./session-reattach.ts";
import {
	type AnthropicSubscriptionSessionEntry,
	closeSession,
	createSessionUuid,
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
import { type AnthropicSubscriptionProviderSettings, resolveColdSeedReplay } from "./settings.ts";

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
	onAttemptStart?: () => void;
	onContinuityDecision?: (observation: ContinuityObservation) => void;
	/** Called once per attempt, before dispatch, with whether it re-sends the whole history and that re-send's bytes/4 estimate. */
	onDispatchShape?: (coldSeed: boolean, estimatedTokens?: number) => void;
	/** Called once when a native-frame seed was rejected and the turn falls back to the flat replay (senpi#1977). */
	onFramesSeedRejected?: (error: unknown) => void;
	/** Set by that fallback: this turn re-sends the history flat, for this reason, whatever continuity would decide. */
	flatReplayReason?: "frames_seed_rejected";
};

/** The seeded transcript the latest attempt of a turn wrote, so a rejected seed can be cleaned up. */
type FramesDispatch = { transcriptPath?: string };

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
	dispatch: FramesDispatch,
): Promise<ReturnType<typeof createSessionTurnAttempt>> {
	const sessionId = input.streamOptions.sessionId!;
	const messages = sentMessages(input.context);
	const hashes = sentMessageHashes(messages);
	const existing = getSession(sessionId);
	const fingerprint = configFingerprint(auth.options, input.context, auth.authLane, auth.accountName);
	const residentHashes = existing ? (sentHashesForEntry(existing) ?? hashes) : hashes;
	const { binding, transcriptAvailable } = await admitRestoredBinding(sessionId, auth.options.cwd, auth.authLane);
	const servedLineage = getBinding(sessionId);
	const lineageSeat = existing?.accountName ?? servedLineage?.accountName ?? binding?.accountName;
	const seat = {
		seat: seatDigest(auth.accountName),
		...(lineageSeat === undefined ? {} : { seatChanged: lineageSeat !== auth.accountName }),
	};
	const decision = decideNativeContinuity({
		entry: existing ? entrySnapshot(existing, residentHashes) : undefined,
		binding,
		currentHashes: hashes,
		accountName: auth.accountName,
		modelId: input.model.id,
		fingerprint,
		transcriptAvailable,
		// claude-cli accounts share one transcript root through their `projects` link, like oauth-slots.
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
	// A cold seed creates its entry only after the seed is sized (and written), so the spawn can resume it.
	let entry: AnthropicSubscriptionSessionEntry | undefined;
	let from = 0;
	let flatten = decision.kind === "flatten" || decision.kind === "bootstrap";

	if (input.flatReplayReason !== undefined) {
		if (existing) closeSession(sessionId, input.flatReplayReason);
		observedKind = "cold-seed";
		observedReason = input.flatReplayReason;
		flatten = true;
	} else if (decision.kind === "delta" && existing) {
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
		}
	} else if (existing) {
		closeSession(sessionId, observedReason ?? "registry_miss");
	}

	const cwd = auth.options.cwd;
	const configDir = seedConfigDir(auth.options.env);
	const historyTranscript =
		flatten &&
		input.flatReplayReason === undefined &&
		resolveColdSeedReplay(input.providerSettings) === "frames" &&
		cwd !== undefined &&
		configDir !== undefined &&
		framesApply(input.context)
			? await loadHistoryTranscript()
			: undefined;
	const cacheTtl = pinnedPromptCacheTtl(auth.options.env);
	const framesSeed =
		historyTranscript && cwd !== undefined
			? buildColdSeedFrames(historyTranscript, input.context, {
					sdkSessionId: createSessionUuid(),
					cwd,
					model: input.model,
					customToolNameToSdk: input.customToolNameToSdk,
					...(input.toolWatchNote === undefined ? {} : { toolWatchNote: input.toolWatchNote }),
					...(cacheTtl === undefined ? {} : { cacheTtl }),
				})
			: undefined;
	const flattenResult =
		flatten && framesSeed === undefined
			? dedupeUltraworkBlocks(buildPromptBlocks(input.context, input.customToolNameToSdk, input.toolWatchNote))
			: undefined;
	const estimatedTokens = framesSeed
		? estimateColdSeedTokens(input.context, framesSeed.estimateBlocks)
		: flattenResult
			? estimateColdSeedTokens(input.context, flattenResult.blocks)
			: undefined;
	input.onDispatchShape?.(flatten, estimatedTokens);
	const overBudget =
		estimatedTokens !== undefined
			? coldSeedOverflow(input.model, estimatedTokens, coldSeedCalibration(sessionId))
			: undefined;
	if (overBudget) {
		// Never dispatch a re-send that cannot fit: the SDK cannot compact a single
		// exchange, so the overflow must reach senpi's own compaction instead. The
		// calibration learned from this session's earlier rejection sizes it the way
		// the API counts, so a compacted re-send that is still too long is refused
		// here instead of costing another round trip. Nothing was spawned or written yet.
		recordPendingCloseCause(sessionId, "cold_seed_over_budget");
		throw overBudget;
	}
	if (framesSeed && historyTranscript && cwd !== undefined) {
		dispatch.transcriptPath = historyTranscript.writeSeedTranscript(configDir, cwd, framesSeed.entries);
	}
	entry ??= getOrCreateSession({
		senpiSessionId: sessionId,
		accountName: auth.accountName,
		modelId: input.model.id,
		...fingerprint,
		options: auth.options,
		...(framesSeed ? { resume: { sdkSessionId: framesSeed.sdkSessionId } } : {}),
	});
	// The seeded lineage is resumable at every replayed assistant, so a later divergence can fork instead of re-seeding.
	for (const [index, uuid] of framesSeed?.assistantUuidBySentCount ?? []) entry.assistantUuidByIndex.set(index, uuid);
	// A claude-cli account checks what its CLI initialized with before any prompt is pushed (senpi#4436).
	if (auth.verifyInitialization && entry.query.initializationResult) {
		try {
			await auth.verifyInitialization(
				await initializationOrAbort(entry.query.initializationResult(), input.streamOptions.signal),
			);
		} catch (error) {
			closeSession(
				sessionId,
				input.streamOptions.signal?.aborted ? "initialization_aborted" : "initialization_refused",
			);
			throw error;
		}
	}
	// Every branch above either reuses a subprocess whose token matched (delta)
	// or spawned one with auth.options, so the entry now runs on this token.
	entry.credentialDigest = auth.credentialDigest;
	const blocks = framesSeed
		? framesSeed.prompt
		: flattenResult
			? flattenResult.blocks
			: buildDeltaPromptBlocks(messages.slice(from), input.customToolNameToSdk);
	const payloadBytes = framesSeed
		? framesSeed.payloadBytes
		: flattenResult
			? serializedPayloadBytes(flattenResult.blocks)
			: undefined;
	const divergedPath =
		observedReason === "assistant_rewritten" ? (existing?.pendingForkDivergedPath ?? undefined) : undefined;
	const staged = stageContinuityDecision(
		{
			...observeSessionSyncDecision({
				kind: observedKind,
				reason: observedReason,
				deltaMessages: flatten ? hashes.length : hashes.length - from,
				firstTurn,
				senpiSessionId: sessionId,
				...(payloadBytes !== undefined ? { payloadBytes } : {}),
				...(flattenResult?.collapsedDirectives !== undefined
					? { collapsedDirectives: flattenResult.collapsedDirectives }
					: {}),
				...(divergedPath === undefined ? {} : { divergedPath }),
				...(flatten ? { replayMode: framesSeed ? ("frames" as const) : ("flat" as const) } : {}),
			}),
			...seat,
		},
		sessionId,
		input.onContinuityDecision,
		// The pending close cause is consumed only when the staged observation
		// actually emits (attempt retained) — a discarded attempt leaves the
		// cause pending for the next admission.
		() => consumePendingCloseCause(sessionId),
	);
	return createSessionTurnAttempt(
		entry,
		userMessage(blocks),
		hashes,
		input.streamOptions.signal,
		staged,
		servedLineage,
	);
}

export async function* residentSessionMessages(input: ResidentSessionStreamInput): AsyncGenerator<SDKMessage> {
	const dispatch: FramesDispatch = {};
	try {
		yield* withFlatFallbackOnce(
			residentAuthLaneMessages(input, dispatch),
			() => dispatch.transcriptPath !== undefined,
			(rejection) => {
				input.onFramesSeedRejected?.(rejection);
				const sessionId = input.streamOptions.sessionId;
				if (sessionId !== undefined) {
					closeSession(sessionId, "frames_seed_rejected");
					forgetBinding(sessionId);
				}
				if (dispatch.transcriptPath !== undefined) rmSync(dispatch.transcriptPath, { force: true });
				return residentAuthLaneMessages({ ...input, flatReplayReason: "frames_seed_rejected" }, {});
			},
		);
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

function residentAuthLaneMessages(
	input: ResidentSessionStreamInput,
	dispatch: FramesDispatch,
): AsyncIterable<SDKMessage> {
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
		onAttemptStart: input.onAttemptStart,
		createAttempt: (auth) => createResidentAttempt(input, auth, dispatch),
	});
}
