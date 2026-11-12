import { createHash, randomUUID } from "node:crypto";
import { type AssistantMessageEvent, sanitizeProviderDiagnostic } from "@earendil-works/pi-ai";
import { credentialPoolBlockedDiagnostic } from "@earendil-works/pi-ai/utils/provider-diagnostic-vocabulary";
import type { SlotHasher } from "@earendil-works/pi-ai/auth/pool/select";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import {
	emitProviderAccountFailover,
	emitProviderAccountsChanged,
} from "../extensions/builtin/anthropic-subscription/account-events.ts";
import type { SdkErrorKind } from "../extensions/builtin/anthropic-subscription/errors.ts";
import { subscriptionLimits } from "../subscription-limits/limit-store.ts";
import { AUTH_BLOCK_REPROBE_MS } from "./auth-reprobe.ts";
import { appendCredentialBlockLog, redactBlockExcerpt } from "./block-log.ts";
import { type CredentialBlock, classifyCredentialFailure, credentialFailureText } from "./classify.ts";
import { runCredentialFailover } from "./failover.ts";
import { STORE_BUSY, writeHealthUnlessStoreBusy } from "./health-write.ts";
import { modelBlockKey, pruneModelBlocks, withModelBlock } from "./model-scope.ts";
import { isCommittedRotationOutput, isRotationStreamStart, rotationErrorFromEvent } from "./rotation-events.ts";
import { listRotationSlots, type RotationSlot, type RotationSources, releaseProbeLease } from "./rotation-slots.ts";
import { roundRobinState } from "./round-robin-state.ts";
import {
	orderRotationSlots,
	pickRotationSlot,
	rememberedHeadroomAccount,
	rememberHeadroomAccount,
	type SlotPickPolicy,
} from "./session-slot.ts";
import { type CredentialSlotState, KNOWN_SLOT_STATE_FIELDS } from "./state-store.ts";

export { listRotationSlots, type RotationLane, type RotationSlot, type RotationSources } from "./rotation-slots.ts";

/** The exact hash the claude-sdk-oauth affinity oracle uses, so pools never remap. */
export const sha256SlotHasher: SlotHasher = (input) => createHash("sha256").update(input).digest().readBigUInt64BE(0);

/**
 * A limit naming one model family lands on that family only: the slot's own
 * health (account block, failure count) is kept as it was, so the slot keeps
 * serving every other model. A half-open probe lease this attempt held is
 * released so the next caller can probe the slot for another model.
 */
/**
 * Whether `current` was recorded for the credential this write is about. A stored slot keys its health
 * by the account or by the token (senpi#4093), so a write under one key over an entry recorded under the
 * other key for the same live credential is the same lineage, not a new credential (senpi#5097).
 */
function sameLineage(
	current: CredentialSlotState | undefined,
	credentialRevision: string | undefined,
	lineage: readonly string[],
): current is CredentialSlotState {
	if (current === undefined) return false;
	if (current.credentialRevision === credentialRevision) return true;
	return current.credentialRevision !== undefined && lineage.includes(current.credentialRevision);
}

function modelBlockPatch(
	family: string,
	modelId: string,
	blockedUntil: number,
	current: CredentialSlotState | undefined,
	now: number,
	credentialRevision: string | undefined,
	lineage: readonly string[],
): Omit<CredentialSlotState, "stateVersion"> {
	const sameMaterial = sameLineage(current, credentialRevision, lineage);
	const { stateVersion: _stateVersion, ...kept } = sameMaterial ? current : { stateVersion: 0 };
	return {
		...kept,
		lease: undefined,
		...(credentialRevision === undefined ? {} : { credentialRevision }),
		modelBlocks: withModelBlock(
			sameMaterial ? current.modelBlocks : undefined,
			modelBlockKey(family, modelId),
			blockedUntil,
			now,
		),
	};
}

function blockPatch(
	block: CredentialBlock,
	current: CredentialSlotState | undefined,
	now: number,
	credentialRevision?: string,
	policy?: { cooldownBaseMs?: number; cooldownCapMs?: number },
	modelId?: string,
	lineage: readonly string[] = [],
): Omit<CredentialSlotState, "stateVersion"> {
	if (block.reason === "rate_limit" && block.modelFamily !== undefined && modelId !== undefined) {
		const blockedUntil = now + Math.min(policy?.cooldownCapMs ?? block.cooldownMs, block.cooldownMs);
		return modelBlockPatch(block.modelFamily, modelId, blockedUntil, current, now, credentialRevision, lineage);
	}
	// Health belongs to the credential that earned it: a new credential starts clean, while the same
	// credential keeps its counters, model blocks, and the fields another engine version wrote (senpi#5097).
	const kept = sameLineage(current, credentialRevision, lineage) ? current : undefined;
	// Only fields this engine does not own carry over: a known field (a usage-limit pause, a lease) is decided
	// below, so one this engine adds to the schema later is never kept stale by mistake.
	const unknownFields = Object.fromEntries(
		Object.entries(kept ?? {}).filter(([field]) => !KNOWN_SLOT_STATE_FIELDS.has(field)),
	);
	const failureCount = (kept?.failureCount ?? 0) + 1;
	const liveModelBlocks = kept === undefined ? undefined : pruneModelBlocks(kept.modelBlocks, now);
	const base = {
		...unknownFields,
		failureCount,
		...(credentialRevision === undefined ? {} : { credentialRevision }),
		...(kept?.lastSuccessAt === undefined ? {} : { lastSuccessAt: kept.lastSuccessAt }),
		...(liveModelBlocks === undefined ? {} : { modelBlocks: liveModelBlocks }),
	};
	if (block.reason === "rate_limit") {
		return {
			...base,
			blockedUntil: now + Math.min(policy?.cooldownCapMs ?? block.cooldownMs, block.cooldownMs),
			blockReason: "rate_limit",
			...(block.usageLimit ? { usageLimit: true as const } : {}),
		};
	}
	if (block.reason === "auth_error")
		return { ...base, blockedUntil: now + AUTH_BLOCK_REPROBE_MS, blockReason: "auth_error" };
	return { ...base, blockReason: block.reason };
}

/**
 * The last slot's error, forwarded when every slot is limited, carries the time the first slot is due back:
 * a limit the provider classified keeps its own reset when it named one, and a failure with no diagnostic or
 * an unclassified 429 becomes the pool's rate limit (senpi#3975). Anything else (auth, a 402/403/404 status)
 * is left exactly as the provider said, status included.
 */
function withPoolRetryAt(event: AssistantMessageEvent, retryAt: number): AssistantMessageEvent {
	if (event.type !== "error") return event;
	const own = sanitizeProviderDiagnostic(event.error.providerDiagnostic);
	const limit = own?.category === "rate_limit" || own?.category === "quota";
	const unclassifiedLimit = own === undefined || (own.category === "unknown" && own.httpStatus === 429);
	if (!limit && !unclassifiedLimit) return event;
	const providerDiagnostic =
		own !== undefined && limit
			? (sanitizeProviderDiagnostic({ ...own, resetsAt: own.resetsAt ?? retryAt }) ?? own)
			: credentialPoolBlockedDiagnostic(retryAt);
	return providerDiagnostic === undefined ? event : { ...event, error: { ...event.error, providerDiagnostic } };
}

function failoverReason(block: CredentialBlock): SdkErrorKind {
	return block.reason === "account_disabled" ? "billing" : block.reason;
}

export type CredentialRotationOptions = {
	sources: RotationSources;
	/** Stable session key keeps a session on its slot; absent, each request distributes. */
	affinityKey?: string;
	/** The requested model: a limit naming its family blocks only that family on the slot (senpi#2555). */
	modelId?: string;
	hasher?: SlotHasher;
	runAttempt: (
		slot: RotationSlot,
	) => AsyncIterable<AssistantMessageEvent> | Promise<AsyncIterable<AssistantMessageEvent>>;
};

/**
 * In-lane credential rotation for one provider request. Selection follows the
 * configured strategy for the affinity key. Rotation and same-slot retry stay transparent
 * while only announcement frames have reached the caller; the first delta bars
 * them, and a failure after it is forwarded as the provider's own terminal
 * event for the session layer to recover from.
 *
 * Account listings read this health, so a block, or a success that lifts one,
 * publishes an account change once its write has committed, whether or not
 * another account takes over. A write the busy store skipped publishes nothing.
 */
export function streamWithCredentialRotation(
	options: CredentialRotationOptions,
): AsyncGenerator<AssistantMessageEvent> {
	const { sources, runAttempt } = options;
	const hasher = options.hasher ?? sha256SlotHasher;
	const affinityKey = options.affinityKey ?? randomUUID();
	const useAffinity = sources.policy?.accountStrategy !== undefined || sources.policy?.affinity !== false;
	const pooled: PooledCredential | undefined = sources.credential;
	const now = sources.now ?? Date.now;
	const rememberAffinity = useAffinity && options.affinityKey !== undefined;
	const roundRobin =
		sources.policy?.accountStrategy === "round-robin"
			? roundRobinState.session(sources.providerId, options.affinityKey)
			: undefined;
	// The account a failover just left. The switch is announced once the next account's attempt starts,
	// so RPC clients and the TUI hear "from -> to" only for a switch that actually happens (senpi#2304).
	let leaving: { name: string; block: CredentialBlock } | undefined;

	return runCredentialFailover<AssistantMessageEvent, RotationSlot>({
		listSlots: () => listRotationSlots(sources, options.modelId === undefined ? {} : { modelId: options.modelId }),
		select: (candidates) => {
			const remembered =
				roundRobin?.account ??
				(rememberAffinity
					? rememberedHeadroomAccount(sources.repository, sources.providerId, affinityKey)
					: undefined);
			const policy: SlotPickPolicy = {
				affinityKey,
				useAffinity,
				hasher,
				...(pooled?.order === undefined ? {} : { order: pooled.order }),
				...(sources.policy?.accountStrategy === undefined ? {} : { strategy: sources.policy.accountStrategy }),
				...(roundRobin === undefined ? {} : { roundRobinOffset: roundRobin.offset }),
				headroom: {
					providerId: sources.providerId,
					limits: subscriptionLimits.snapshot(),
					now: now(),
					...(remembered === undefined ? {} : { remembered }),
				},
			};
			const winner = pickRotationSlot(candidates, policy);
			if (!winner) throw new Error("credential rotation selected from an empty candidate set");
			// A pinned winner is the user's choice, not a headroom move or a round-robin turn, so it is never remembered.
			if (roundRobin !== undefined) {
				if (winner.pinned !== true) roundRobin.account = winner.name;
			} else if (
				rememberAffinity &&
				winner.pinned !== true &&
				(remembered !== undefined || winner !== orderRotationSlots(candidates, policy)[0])
			) {
				rememberHeadroomAccount(sources.repository, sources.providerId, affinityKey, winner.name);
			}
			return winner;
		},
		runAttempt: (slot) => {
			if (leaving !== undefined && leaving.name !== slot.name) {
				emitProviderAccountFailover(sources.providerId, leaving.name, slot.name, failoverReason(leaving.block));
			}
			leaving = undefined;
			return runAttempt(slot);
		},
		onRotate: ({ slot, block, committedOutput }) => {
			leaving = committedOutput ? undefined : { name: slot.name, block };
		},
		isCommittedOutput: isCommittedRotationOutput,
		isStreamStart: isRotationStreamStart,
		errorFromEvent: rotationErrorFromEvent,
		withPoolRetryAt,
		classify: (error, context) =>
			classifyCredentialFailure(error, {
				...context,
				nowMs: now(),
				cooldownBaseMs: sources.policy?.cooldownBaseMs,
				cooldownCapMs: sources.policy?.cooldownCapMs,
			}),
		onSuccess: async (slot) => {
			let released = false;
			const written = await writeHealthUnlessStoreBusy(`success on ${slot.name}`, () =>
				sources.repository.mutateSlotState(sources.providerId, slot.lane, slot.name, (current) => {
					if (!current) return undefined;
					// Serving one model says nothing about another model's quota:
					// only the blocks on the model that just served are lifted.
					const modelBlocks = pruneModelBlocks(current.modelBlocks, now(), options.modelId);
					released =
						current.blockedUntil !== undefined ||
						current.blockReason !== undefined ||
						Object.keys(modelBlocks ?? {}).length !== Object.keys(current.modelBlocks ?? {}).length;
					return {
						...current,
						// Health a success leaves behind belongs to the account, not to this token (senpi#4093).
						...(slot.storedRevision === undefined ? {} : { credentialRevision: slot.storedRevision }),
						lastSuccessAt: now(),
						lease: undefined,
						blockedUntil: undefined,
						blockReason: undefined,
						usageLimit: undefined,
						// A healthy answer ends the failure run; a later limit starts its backoff afresh (senpi#3771).
						failureCount: undefined,
						modelBlocks,
					};
				}),
			);
			// A healthy account answering again changes nothing a listing shows.
			if (written !== STORE_BUSY && released) emitProviderAccountsChanged(sources.providerId);
		},
		// A probe that ended without a verdict hands its lease back at once instead of holding the slot
		// for the lease's whole TTL (senpi#4094).
		// Only the lease this request took: `slot.lease` mirrors the shared file and can be another request's.
		releaseSlot: async (slot) => {
			if (slot.heldLeaseId === undefined) return;
			await releaseProbeLease(sources.repository, sources.providerId, slot.lane, slot.name, slot.heldLeaseId);
		},
		persistBlock: async (slot, block, error) => {
			const revision =
				slot.lane === "env" && slot.envVarName !== undefined && slot.envKey !== undefined
					? await sources.repository.envCredentialRevision(slot.envVarName, slot.envKey)
					: // A rejected token is a verdict on that token; every other block is a verdict on the account (senpi#4093).
						block.reason === "auth_error"
						? slot.materialRevision
						: slot.storedRevision;
			const written = await writeHealthUnlessStoreBusy(`${block.reason} block on ${slot.name}`, () =>
				sources.repository.mutateSlotState(sources.providerId, slot.lane, slot.name, (current) =>
					blockPatch(block, current, now(), revision, sources.policy, options.modelId, [
						...(slot.storedRevision === undefined ? [] : [slot.storedRevision]),
						...(slot.materialRevision === undefined ? [] : [slot.materialRevision]),
					]),
				),
			);
			if (written !== STORE_BUSY) emitProviderAccountsChanged(sources.providerId);
			const blockedUntil = written === STORE_BUSY ? undefined : written?.blockedUntil;
			const blockLogPath = sources.repository.blockLogPath?.();
			if (blockLogPath !== undefined)
				appendCredentialBlockLog(blockLogPath, {
					at: new Date(now()).toISOString(),
					provider: sources.providerId,
					slot: slot.name,
					reason: block.reason,
					...(blockedUntil === undefined ? {} : { blockedUntil: new Date(blockedUntil).toISOString() }),
					...(block.reason === "rate_limit" && block.resetSource !== undefined
						? { resetSource: block.resetSource }
						: {}),
					...(block.reason === "rate_limit" && block.modelFamily !== undefined
						? { model: block.modelFamily }
						: {}),
					...(error === undefined ? {} : { excerpt: redactBlockExcerpt(credentialFailureText(error)) }),
				});
		},
		now,
	});
}
