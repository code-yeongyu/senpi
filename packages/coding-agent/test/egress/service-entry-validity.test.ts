import { describe, expect, it } from "vitest";
import { type RosterView, type ServiceKeyEntry, verifyServiceSig } from "../../src/core/egress/roster-entries.ts";
import {
	type LocalKeyVerification,
	serviceEntryValidity,
	verificationFor,
} from "../../src/core/egress/verified-keys.ts";
import type { VerifierRevocation } from "../../src/core/egress/verifier-revocations.ts";
import { p256Signer, registryFields, signedEntry } from "./signed-entry.ts";

const ACCOUNT = "omo-account";
const NOW = 70_000_000;
const MONO = 2_000;
const known = (...serviceEntries: ServiceKeyEntry[]): RosterView => ({
	state: "known",
	serviceEntries,
	rosterVersion: 1,
	rosterIssuedAt: NOW - 60_000,
	rosterExpiresAt: NOW + 14 * 60_000,
	receivedMono: MONO - 60_000,
});
const validity = (
	entry: ServiceKeyEntry,
	accountId: string,
	records: readonly LocalKeyVerification[],
	roster: RosterView,
	revocations: readonly VerifierRevocation[] = [],
) => serviceEntryValidity(entry, accountId, records, roster, { revocations, now: NOW, nowMono: MONO });

async function checked(...entries: ServiceKeyEntry[]): Promise<LocalKeyVerification[]> {
	const records: LocalKeyVerification[] = [];
	for (const entry of entries) {
		const record = await verificationFor(entry, ACCOUNT, 5, { verifierKeyId: "verifier-1", vouchedAt: 4 });
		if (!record) throw new Error("fixture entry cannot be recorded");
		records.push(record);
	}
	return records;
}

describe("serviceEntryValidity", () => {
	it("is valid only with this device's own record, pending without it", async () => {
		const entry = await signedEntry(registryFields(1));
		expect(await validity(entry, ACCOUNT, await checked(entry), known(entry))).toBe("valid");
		expect(await validity(entry, ACCOUNT, [], known(entry))).toBe("pending");
	});

	it("ignores other devices entirely: their attestations and their revocation change nothing", async () => {
		const entry = await signedEntry(registryFields(1));
		const attested = { ...entry, attestations: [{ deviceId: "revoked-device", checkedAt: 1, sig: "eA==" }] };
		expect(await validity(attested, ACCOUNT, [], known(attested))).toBe("pending");
		expect(await validity(attested, ACCOUNT, await checked(entry), known(attested))).toBe("valid");
	});

	it("is invalid when the self-signature does not verify, even with a local record", async () => {
		const entry = await signedEntry(registryFields(1));
		const retargeted = {
			...entry,
			kmsKeyArns: ["arn:aws:kms:us-east-1:111122223333:key/00000000-0000-4000-8000-0000000000ff"],
		};
		expect(await validity(retargeted, ACCOUNT, await checked(entry), known(retargeted))).toBe("invalid");
	});

	it("verifies the signature only under the entry's own key id", async () => {
		const entry = await signedEntry(registryFields(1));
		expect(await verifyServiceSig({ ...entry, serviceSig: { ...entry.serviceSig, keyId: "reg-0" } })).toBe(false);
	});

	it("is invalid for an entry of another account, whatever this device recorded", async () => {
		const entry = await signedEntry(registryFields(1));
		expect(await validity(entry, "other-account", await checked(entry), known(entry))).toBe("invalid");
		expect(
			await verificationFor(entry, "other-account", 5, { verifierKeyId: "verifier-1", vouchedAt: 4 }),
		).toBeUndefined();
	});

	it("does not accept an attacker key that copies a checked key's ids", async () => {
		const real = await signedEntry(registryFields(1));
		const impostor = await signedEntry(registryFields(1));
		expect(impostor.sigKeyId).toBe(real.sigKeyId);
		expect(await validity(impostor, ACCOUNT, await checked(real), known(impostor))).toBe("pending");
	});

	it("is unknown while two differently keyed, validly signed entries claim one generation", async () => {
		const real = await signedEntry(registryFields(1));
		const twin = await signedEntry(registryFields(1));
		expect(await validity(real, ACCOUNT, await checked(real), known(real, twin))).toBe("unknown");
		const forgedTwin = { ...twin, serviceSig: real.serviceSig };
		expect(await validity(real, ACCOUNT, await checked(real), known(real, forgedTwin))).toBe("valid");
	});

	it("is unknown while two entries with one key disagree on what they supersede", async () => {
		const old = await signedEntry(registryFields(1));
		const signer = await p256Signer();
		const revoker = await signedEntry(registryFields(2, old.sigKeyId), signer);
		const reissued = await signedEntry(registryFields(2), signer);
		const records = await checked(revoker, reissued);
		expect(await validity(reissued, ACCOUNT, records, known(revoker, reissued))).toBe("unknown");
		expect(await validity(revoker, ACCOUNT, records, known(revoker, reissued))).toBe("unknown");
		expect(await validity(reissued, ACCOUNT, records, known(reissued))).toBe("valid");
	});

	it("is superseded once this device checked a higher generation that revokes it, and stays so after a roster rollback", async () => {
		const old = await signedEntry(registryFields(1));
		const next = await signedEntry(registryFields(2, old.sigKeyId));
		const records = await checked(old, next);
		expect(await validity(old, ACCOUNT, records, known(old, next))).toBe("superseded");
		expect(await validity(old, ACCOUNT, records, known(old))).toBe("superseded");
	});

	it("is not superseded by an unchecked revoker, or by a revoker of an equal or lower generation", async () => {
		const old = await signedEntry(registryFields(2));
		const unchecked = await signedEntry(registryFields(3, old.sigKeyId));
		expect(await validity(old, ACCOUNT, await checked(old), known(old, unchecked))).toBe("valid");
		const lower = await signedEntry(registryFields(1, old.sigKeyId));
		expect(await validity(old, ACCOUNT, await checked(old, lower), known(old, lower))).toBe("valid");
	});

	it("is unknown while the roster is unknown", async () => {
		const entry = await signedEntry(registryFields(1));
		expect(await validity(entry, ACCOUNT, await checked(entry), { state: "unknown" })).toBe("unknown");
	});

	// Design 15.10 "Signed revocation statements": records whose verifierKeyId/vouchedAt fall under a revocation count
	// "as absent at once, so the device re-checks".
	it("records-vouched-by-revoked-verifier-rechecked: a record vouched by a revoked verifier key counts as absent", async () => {
		const old = await signedEntry(registryFields(1));
		const next = await signedEntry(registryFields(2, old.sigKeyId));
		const records = await checked(old, next);
		expect(await validity(old, ACCOUNT, records, known(old, next))).toBe("superseded");
		expect(await validity(next, ACCOUNT, records, known(old, next), [{ keyId: "verifier-1" }])).toBe("pending");
		expect(await validity(old, ACCOUNT, records, known(old, next), [{ keyId: "verifier-1" }])).toBe("superseded");
		expect(await validity(next, ACCOUNT, records, known(old, next), [{ keyId: "verifier-1", from: 0, to: 3 }])).toBe(
			"valid",
		);
		expect(await validity(next, ACCOUNT, records, known(old, next), [{ keyId: "verifier-1", from: 4, to: 4 }])).toBe(
			"pending",
		);
	});

	it("is unknown once the roster view is past its freshness bound", async () => {
		const entry = await signedEntry(registryFields(1));
		const stale = { ...known(entry), rosterExpiresAt: NOW };
		expect(await validity(entry, ACCOUNT, await checked(entry), stale)).toBe("unknown");
	});
});
