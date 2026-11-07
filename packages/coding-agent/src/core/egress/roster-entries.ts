/**
 * Roster entry kinds for hosted model-key custody (row CK11; custody design 2.2 and 3.1).
 *
 * A `device-kem` entry publishes a device's HPKE recipient key. A service entry (`custody`, current or
 * standby, and `placement-registry`, optionally superseding an earlier registry generation) publishes a
 * KMS-held key of the Custody Service. A service entry is usable by a device only after THAT device ran
 * `checkServiceKey` on it and stored a `LocalKeyVerification` record (`verified-keys.ts`);
 * attestations other devices posted are informational and never make an entry valid.
 *
 * Everything here is a parser or a pure check over untrusted input: parsers return `undefined` for any
 * shape they do not recognise, and verification returns `false` instead of throwing.
 */
import { canonicalJson } from "@earendil-works/pi-agent-core";
import { verifyEcdsaP256Sha256 } from "./ecdsa-p256.ts";

export type DeviceId = string;

export interface ServiceSig {
	readonly alg: "ECDSA-P256-SHA256";
	readonly keyId: string;
	/** Base64 of the DER-encoded ECDSA signature, as KMS `Sign` returns it. */
	readonly sig: string;
}

export interface DeviceKemEntry {
	readonly kind: "device-kem";
	readonly deviceId: DeviceId;
	readonly kemPk: string;
	readonly sig: string;
}

export interface ServiceKeyAttestation {
	readonly deviceId: DeviceId;
	readonly checkedAt: number;
	readonly sig: string;
}

export type ServiceKeyKind = "custody" | "placement-registry";

export interface ServiceKeyEntry {
	readonly kind: ServiceKeyKind;
	readonly accountId: string;
	readonly generation: number;
	/** Custody only: the P-256 key-agreement key (base64 SPKI DER) and its id. */
	readonly kemKeyId?: string;
	readonly kemPk?: string;
	/** The ECDSA P-256 signing key (base64 SPKI DER) and its id. */
	readonly sigKeyId: string;
	readonly sigPk: string;
	readonly kmsKeyArns: readonly string[];
	/** Which pinned `KeyPolicyTemplate` the KMS keys were created with. */
	readonly templateVersion: number;
	readonly role: "current" | "standby";
	/** Placement-registry only: the `sigKeyId` of the registry generation this entry revokes. */
	readonly supersedes?: string;
	readonly createdAt: number;
	readonly serviceSig: ServiceSig;
	/** Informational only: never consulted by any validity decision. */
	readonly attestations: readonly ServiceKeyAttestation[];
}

/**
 * This device's view of its account roster: UNKNOWN until a roster sync has been proven good. A known view keeps
 * the verified roster's `rv`, `iat` and `exp` (ms) and the local monotonic time it was received (15.15 H-1).
 */
export type RosterView =
	| { readonly state: "unknown" }
	| {
			readonly state: "known";
			readonly serviceEntries: readonly ServiceKeyEntry[];
			readonly rosterVersion: number;
			readonly rosterIssuedAt: number;
			readonly rosterExpiresAt: number;
			readonly receivedMono: number;
	  };

const UNKNOWN_ROSTER: RosterView = { state: "unknown" };

/**
 * The view as of wall-clock `now` and monotonic `nowMono`: `unknown` at the earlier of the roster's lifetime
 * elapsed on the monotonic clock since receipt and `max(now, iat) >= exp` on the wall clock (15.15 H-1, 15.16 M-1).
 */
export function rosterViewAt(view: RosterView, now: number, nowMono: number): RosterView {
	if (view.state === "unknown") return view;
	const effectiveNow = Math.max(now, view.rosterIssuedAt);
	const age = nowMono - view.receivedMono;
	const lifetime = view.rosterExpiresAt - view.rosterIssuedAt;
	return effectiveNow >= view.rosterExpiresAt || age < 0 || age >= lifetime ? UNKNOWN_ROSTER : view;
}

/** The view to hold after verifying `incoming`: it replaces `held` only when strictly newer (15.16 M-2). */
export function heldRosterView(held: RosterView, incoming: RosterView): RosterView {
	if (incoming.state === "unknown" || held.state === "unknown") return incoming.state === "unknown" ? held : incoming;
	const newer =
		incoming.rosterVersion > held.rosterVersion ||
		(incoming.rosterVersion === held.rosterVersion && incoming.rosterIssuedAt > held.rosterIssuedAt);
	return newer ? incoming : held;
}

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasOnlyKeys(value: JsonRecord, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

const SERVICE_SIG_KEYS = ["alg", "keyId", "sig"] as const;
const ATTESTATION_KEYS = ["deviceId", "checkedAt", "sig"] as const;
const DEVICE_KEM_KEYS = ["kind", "deviceId", "kemPk", "sig"] as const;
const SERVICE_ENTRY_KEYS = [
	"kind",
	"accountId",
	"generation",
	"kemKeyId",
	"kemPk",
	"sigKeyId",
	"sigPk",
	"kmsKeyArns",
	"templateVersion",
	"role",
	"supersedes",
	"createdAt",
	"serviceSig",
	"attestations",
] as const;

function parseServiceSig(value: unknown): ServiceSig | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, SERVICE_SIG_KEYS)) return undefined;
	if (value.alg !== "ECDSA-P256-SHA256" || !isNonEmptyString(value.keyId) || !isNonEmptyString(value.sig))
		return undefined;
	return { alg: value.alg, keyId: value.keyId, sig: value.sig };
}

function parseAttestation(value: unknown): ServiceKeyAttestation | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, ATTESTATION_KEYS)) return undefined;
	if (!isNonEmptyString(value.deviceId) || !isNonNegativeInteger(value.checkedAt) || !isNonEmptyString(value.sig)) {
		return undefined;
	}
	return { deviceId: value.deviceId, checkedAt: value.checkedAt, sig: value.sig };
}

export function parseDeviceKemEntry(value: unknown): DeviceKemEntry | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, DEVICE_KEM_KEYS) || value.kind !== "device-kem") return undefined;
	if (!isNonEmptyString(value.deviceId) || !isNonEmptyString(value.kemPk) || !isNonEmptyString(value.sig))
		return undefined;
	return { kind: "device-kem", deviceId: value.deviceId, kemPk: value.kemPk, sig: value.sig };
}

/**
 * Strict parser for a service key entry. Kind-specific shape is enforced here so later checks never see
 * a custody entry without a KEM key, a registry entry carrying one, or `supersedes` on a custody entry.
 */
export function parseServiceKeyEntry(value: unknown): ServiceKeyEntry | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, SERVICE_ENTRY_KEYS)) return undefined;
	const { kind, role } = value;
	if (kind !== "custody" && kind !== "placement-registry") return undefined;
	if (role !== "current" && role !== "standby") return undefined;
	if (!isNonEmptyString(value.accountId) || !isNonNegativeInteger(value.generation)) return undefined;
	if (!isNonEmptyString(value.sigKeyId) || !isNonEmptyString(value.sigPk)) return undefined;
	if (!isNonNegativeInteger(value.templateVersion) || !isNonNegativeInteger(value.createdAt)) return undefined;
	if (!Array.isArray(value.kmsKeyArns) || !value.kmsKeyArns.every(isNonEmptyString)) return undefined;
	const serviceSig = parseServiceSig(value.serviceSig);
	if (!serviceSig || !Array.isArray(value.attestations)) return undefined;
	const attestations: ServiceKeyAttestation[] = [];
	for (const raw of value.attestations) {
		const attestation = parseAttestation(raw);
		if (!attestation) return undefined;
		attestations.push(attestation);
	}

	const { kemKeyId, kemPk, supersedes } = value;
	let kem: { readonly kemKeyId: string; readonly kemPk: string } | undefined;
	if (kind === "custody") {
		if (!isNonEmptyString(kemKeyId) || !isNonEmptyString(kemPk) || supersedes !== undefined) return undefined;
		kem = { kemKeyId, kemPk };
	} else {
		if (kemKeyId !== undefined || kemPk !== undefined) return undefined;
		if (supersedes !== undefined && !isNonEmptyString(supersedes)) return undefined;
	}

	return {
		kind,
		accountId: value.accountId,
		generation: value.generation,
		...kem,
		sigKeyId: value.sigKeyId,
		sigPk: value.sigPk,
		kmsKeyArns: [...value.kmsKeyArns],
		templateVersion: value.templateVersion,
		role,
		...(typeof supersedes === "string" ? { supersedes } : {}),
		createdAt: value.createdAt,
		serviceSig,
		attestations,
	};
}

/**
 * The bytes `serviceSig` covers: the canonical JSON of every field except `serviceSig` itself and the
 * informational `attestations` (devices append those after signing). Absent optional fields are omitted,
 * never serialized as null.
 */
export function serviceEntrySigningPayload(entry: ServiceKeyEntry): Uint8Array<ArrayBuffer> {
	const signed: Record<string, Parameters<typeof canonicalJson>[0]> = {
		kind: entry.kind,
		accountId: entry.accountId,
		generation: entry.generation,
		sigKeyId: entry.sigKeyId,
		sigPk: entry.sigPk,
		kmsKeyArns: [...entry.kmsKeyArns],
		templateVersion: entry.templateVersion,
		role: entry.role,
		createdAt: entry.createdAt,
	};
	if (entry.kemKeyId !== undefined) signed.kemKeyId = entry.kemKeyId;
	if (entry.kemPk !== undefined) signed.kemPk = entry.kemPk;
	if (entry.supersedes !== undefined) signed.supersedes = entry.supersedes;
	return new TextEncoder().encode(canonicalJson(signed));
}

/**
 * `serviceSig` is a self-signature: made with the entry's own signing key (`keyId === sigKeyId`) over
 * `serviceEntrySigningPayload`. It proves the entry's fields were signed by that KMS key; whether the key
 * itself is trustworthy is decided only by this device's own `checkServiceKey` record.
 */
export async function verifyServiceSig(entry: ServiceKeyEntry): Promise<boolean> {
	if (entry.serviceSig.keyId !== entry.sigKeyId) return false;
	return verifyEcdsaP256Sha256(entry.sigPk, serviceEntrySigningPayload(entry), entry.serviceSig.sig);
}
