import type {
	ClaimClock,
	ClaimTrust,
	PlacementClaim,
	SignedPlacementClaim,
} from "../../src/core/egress/placement-claim.ts";
import { placementClaimSigningInput } from "../../src/core/egress/placement-claim.ts";
import type { RosterView, ServiceKeyEntry } from "../../src/core/egress/roster-entries.ts";
import { type LocalKeyVerification, verificationFor } from "../../src/core/egress/verified-keys.ts";
import { type P256Signer, p256Signer, p1363ToDer, registryFields, signedEntry, toBase64 } from "./signed-entry.ts";

export const ACCOUNT = "omo-account";
/** The roster's signed issue time; the device clock reads one minute later. */
export const IAT = 70_000_000;
export const NOW = IAT + 60_000;
export const MONO = 2_000;
export const HOUR = 3_600_000;
export const AT: ClaimClock = { now: NOW, nowMono: MONO };

export const knownRoster = (...serviceEntries: ServiceKeyEntry[]): RosterView => ({
	state: "known",
	serviceEntries,
	rosterVersion: 1,
	rosterIssuedAt: IAT,
	rosterExpiresAt: IAT + 15 * 60_000,
	receivedMono: MONO - 60_000,
});

export async function checked(...entries: ServiceKeyEntry[]): Promise<LocalKeyVerification[]> {
	const records: LocalKeyVerification[] = [];
	for (const entry of entries) {
		const record = await verificationFor(entry, ACCOUNT, 5, { verifierKeyId: "verifier-1", vouchedAt: 4 });
		if (!record) throw new Error("fixture entry cannot be recorded");
		records.push(record);
	}
	return records;
}

export interface Registry {
	readonly entry: ServiceKeyEntry;
	readonly signer: P256Signer;
}

export async function registry(generation: number, supersedes?: string): Promise<Registry> {
	const signer = await p256Signer();
	return { entry: await signedEntry(registryFields(generation, supersedes), signer), signer };
}

/** The same published entry, but claims signed by a key that is not its key. */
export async function forgerOf(reg: Registry): Promise<Registry> {
	return { entry: reg.entry, signer: await p256Signer() };
}

export const claimFields = (overrides: Partial<PlacementClaim> = {}): PlacementClaim => ({
	accountId: ACCOUNT,
	placementId: "placement-a",
	epoch: 7,
	registryGeneration: 1,
	issuedAt: NOW - 1_000,
	expiresAt: NOW + HOUR,
	...overrides,
});

export async function signBytes(message: Uint8Array<ArrayBuffer>, by: Registry): Promise<string> {
	return toBase64(p1363ToDer(await by.signer.sign(message)));
}

export async function signClaim(
	claim: PlacementClaim,
	by: Registry,
	keyId = by.entry.sigKeyId,
): Promise<SignedPlacementClaim> {
	const sig = await signBytes(placementClaimSigningInput(claim), by);
	return { claim, sig: { alg: "ECDSA-P256-SHA256", keyId, sig } };
}

/** A registry entry of generation 1 that this device checked, in a fresh roster, with no accepted epoch yet. */
export async function trusted(overrides: Partial<ClaimTrust> = {}): Promise<{ reg: Registry; trust: ClaimTrust }> {
	const reg = await registry(1);
	return {
		reg,
		trust: {
			accountId: ACCOUNT,
			records: await checked(reg.entry),
			roster: knownRoster(reg.entry),
			revocations: [],
			epochFloor: () => undefined,
			...overrides,
		},
	};
}
