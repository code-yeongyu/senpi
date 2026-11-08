/**
 * Placement claims for hosted model-key custody (row CK7; custody design 2.2, 4.6, 15.15, 15.16, Appendix C.P1).
 *
 * The placement registry signs `{ claim, sig }` for the placement that currently owns a session. A hand executes a
 * brain's request (provider.call.start/result, ToolHost dispatch, hook.model_request, custody.refresh.request) only
 * when `verifyPlacementClaim` answers `valid`. The verdict is total and ordered (C.P1): closed envelope, roster
 * freshness, key selection and local trust, signature/account/epoch/placement, lifetime bounds, expiry. Every input
 * is untrusted; nothing here throws on bad input, and the hand records a new epoch floor only after `valid`.
 */
import { canonicalJson } from "@earendil-works/pi-agent-core";
import { verifyEcdsaP256Sha256 } from "./ecdsa-p256.ts";
import { type RosterView, rosterViewAt, type ServiceKeyEntry, type ServiceSig } from "./roster-entries.ts";
import { hasExactKeys, isRecord, type StatementFields } from "./signed-statement.ts";
import { type LocalKeyVerification, serviceEntryValidity } from "./verified-keys.ts";
import type { VerifierRevocation } from "./verifier-revocations.ts";
import type { ProviderCallErrorCode } from "./wire.ts";

export interface PlacementClaim {
	readonly accountId: string;
	readonly placementId: string;
	readonly epoch: number;
	/** Generation of the placement-registry key that signed this claim (4.6). */
	readonly registryGeneration: number;
	readonly issuedAt: number;
	readonly expiresAt: number;
}

export interface SignedPlacementClaim {
	readonly claim: PlacementClaim;
	readonly sig: ServiceSig;
}

/** A claim may live at most 24 h; the brain renews it at half-life under the same epoch (4.6). */
export const CLAIM_MAX_LIFETIME_MS = 86_400_000;
/** Device-side tolerance for a claim's `issuedAt` in the hand's future (15.15 M-1); `MOVE_SKEW_MS` stays server-side. */
export const CLAIM_ISSUE_SKEW_MS = 300_000;

const PLACEMENT_CLAIM_DOMAIN = "omo-custody/placement-claim/v1";

export type ClaimVerdict = "valid" | "invalid" | "malformed" | "expired" | "superseded" | "unknown";

/** The `provider.call.error` each refusal answers with (4.6, 15.14 M-3, C.P1). */
export const CLAIM_VERDICT_ERRORS = {
	invalid: { code: "stale_epoch", retryable: false },
	malformed: { code: "claim_invalid", retryable: false },
	expired: { code: "claim_expired", retryable: true },
	superseded: { code: "registry_key_revoked", retryable: true },
	unknown: { code: "registry_key_unknown", retryable: true },
} as const satisfies Record<
	Exclude<ClaimVerdict, "valid">,
	{ readonly code: ProviderCallErrorCode; readonly retryable: boolean }
>;

/** The highest epoch this hand accepted for one (account, registry generation), and the placement that held it. */
export interface EpochFloor {
	readonly epoch: number;
	readonly placementId: string;
}

/** What this hand trusts when it checks a claim; supplied by the hand's executor (CK8), read fresh per check. */
export interface ClaimTrust {
	readonly accountId: string;
	readonly records: readonly LocalKeyVerification[];
	readonly roster: RosterView;
	readonly revocations: readonly VerifierRevocation[];
	epochFloor(accountId: string, registryGeneration: number): EpochFloor | undefined;
}

export interface ClaimClock {
	readonly now: number;
	readonly nowMono: number;
}

export interface ClaimVerifier {
	verify(claim: unknown, clock: ClaimClock): Promise<ClaimVerdict>;
}

/** `ASCII(domain) || 0x00 || UTF8(canonicalJson(claim))`: the exact bytes the registry key signs (C.P1). */
export function placementClaimSigningInput(claim: PlacementClaim): Uint8Array<ArrayBuffer> {
	const { accountId, placementId, epoch, registryGeneration, issuedAt, expiresAt } = claim;
	const payload = canonicalJson({ accountId, placementId, epoch, registryGeneration, issuedAt, expiresAt });
	const encoder = new TextEncoder();
	return new Uint8Array([...encoder.encode(PLACEMENT_CLAIM_DOMAIN), 0, ...encoder.encode(payload)]);
}

const CLAIM_KEYS = ["accountId", "placementId", "epoch", "registryGeneration", "issuedAt", "expiresAt"] as const;

function closedRecord(value: unknown, keys: readonly string[]): StatementFields | undefined {
	return isRecord(value) && hasExactKeys(value, keys) ? value : undefined;
}

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
/** A nonnegative safe integer, never -0 (C.P1 boundary rules: no fractions, non-finite values or -0 enter `C`). */
const isCount = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);

/** The closed `{ claim, sig }` envelope, or `undefined` for any other shape (C.P1 canonical input). */
function parseSignedPlacementClaim(value: unknown): SignedPlacementClaim | undefined {
	const envelope = closedRecord(value, ["claim", "sig"]);
	const claim = closedRecord(envelope?.claim, CLAIM_KEYS);
	const sig = closedRecord(envelope?.sig, ["alg", "keyId", "sig"]);
	if (!claim || !sig || sig.alg !== "ECDSA-P256-SHA256" || !isText(sig.keyId) || !isText(sig.sig)) return undefined;
	const { accountId, placementId, epoch, registryGeneration, issuedAt, expiresAt } = claim;
	if (!isText(accountId) || !isText(placementId)) return undefined;
	if (!isCount(epoch) || !isCount(registryGeneration) || !isCount(issuedAt) || !isCount(expiresAt)) return undefined;
	return {
		claim: { accountId, placementId, epoch, registryGeneration, issuedAt, expiresAt },
		sig: { alg: "ECDSA-P256-SHA256", keyId: sig.keyId, sig: sig.sig },
	};
}

type KeySelection = { readonly verdict: "superseded" | "unknown" | "invalid" } | { readonly entry: ServiceKeyEntry };

/**
 * The one registry entry of the claim's generation this hand may verify under. A locally superseded generation is
 * `superseded`; a missing, unchecked or ambiguous key is `unknown`; only bad entries left is `invalid`.
 */
async function selectRegistryKey(
	claim: PlacementClaim,
	trust: ClaimTrust,
	view: Extract<RosterView, { state: "known" }>,
	clock: ClaimClock,
): Promise<KeySelection> {
	const candidates = view.serviceEntries.filter(
		(entry) =>
			entry.kind === "placement-registry" &&
			entry.accountId === trust.accountId &&
			entry.generation === claim.registryGeneration,
	);
	const context = { revocations: trust.revocations, now: clock.now, nowMono: clock.nowMono };
	const validities = await Promise.all(
		candidates.map((entry) => serviceEntryValidity(entry, trust.accountId, trust.records, view, context)),
	);
	if (validities.includes("superseded")) return { verdict: "superseded" };
	const valid = candidates.filter((_, index) => validities[index] === "valid");
	const [first] = valid;
	if (first && valid.every((entry) => entry.sigKeyId === first.sigKeyId && entry.sigPk === first.sigPk))
		return { entry: first };
	const onlyBad = candidates.length > 0 && validities.every((validity) => validity === "invalid");
	return { verdict: onlyBad ? "invalid" : "unknown" };
}

function belowFloor(claim: PlacementClaim, floor: EpochFloor | undefined): boolean {
	if (!floor) return false;
	return claim.epoch < floor.epoch || (claim.epoch === floor.epoch && claim.placementId !== floor.placementId);
}

/** The claim's verdict for this hand (custody design 4.6, 15.15, 15.16 and the total order of C.P1). */
export async function verifyPlacementClaim(
	value: unknown,
	trust: ClaimTrust,
	clock: ClaimClock,
): Promise<ClaimVerdict> {
	const signed = parseSignedPlacementClaim(value);
	if (!signed) return "malformed";
	const view = rosterViewAt(trust.roster, clock.now, clock.nowMono);
	if (view.state === "unknown") return "unknown";
	const { claim, sig } = signed;
	if (claim.accountId !== trust.accountId) return "invalid";
	const selection = await selectRegistryKey(claim, trust, view, clock);
	if ("verdict" in selection) return selection.verdict;
	if (sig.keyId !== selection.entry.sigKeyId) return "invalid";
	if (!(await verifyEcdsaP256Sha256(selection.entry.sigPk, placementClaimSigningInput(claim), sig.sig)))
		return "invalid";
	if (belowFloor(claim, trust.epochFloor(claim.accountId, claim.registryGeneration))) return "invalid";
	const effectiveNow = Math.max(clock.now, view.rosterIssuedAt);
	if (
		claim.expiresAt - claim.issuedAt > CLAIM_MAX_LIFETIME_MS ||
		claim.issuedAt > effectiveNow + CLAIM_ISSUE_SKEW_MS ||
		claim.issuedAt > view.rosterIssuedAt + CLAIM_MAX_LIFETIME_MS
	)
		return "malformed";
	return claim.expiresAt > effectiveNow ? "valid" : "expired";
}
