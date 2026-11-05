import { describe, expect, it } from "vitest";
import { type RosterView, type ServiceKeyEntry, verifyServiceSig } from "../../src/core/egress/roster-entries.ts";
import {
	type LocalKeyVerification,
	serviceEntryValidity,
	verificationFor,
} from "../../src/core/egress/verified-keys.ts";
import { registryFields, signedEntry } from "./signed-entry.ts";

const ACCOUNT = "omo-account";
const known = (...serviceEntries: ServiceKeyEntry[]): RosterView => ({ state: "known", serviceEntries });

async function checked(...entries: ServiceKeyEntry[]): Promise<LocalKeyVerification[]> {
	const records: LocalKeyVerification[] = [];
	for (const entry of entries) {
		const record = await verificationFor(entry, ACCOUNT, 5);
		if (!record) throw new Error("fixture entry cannot be recorded");
		records.push(record);
	}
	return records;
}

describe("serviceEntryValidity", () => {
	it("is valid only with this device's own record, pending without it", async () => {
		const entry = await signedEntry(registryFields(1));
		expect(await serviceEntryValidity(entry, ACCOUNT, await checked(entry), known(entry))).toBe("valid");
		expect(await serviceEntryValidity(entry, ACCOUNT, [], known(entry))).toBe("pending");
	});

	it("ignores other devices entirely: their attestations and their revocation change nothing", async () => {
		const entry = await signedEntry(registryFields(1));
		const attested = { ...entry, attestations: [{ deviceId: "revoked-device", checkedAt: 1, sig: "eA==" }] };
		expect(await serviceEntryValidity(attested, ACCOUNT, [], known(attested))).toBe("pending");
		expect(await serviceEntryValidity(attested, ACCOUNT, await checked(entry), known(attested))).toBe("valid");
	});

	it("is invalid when the self-signature does not verify, even with a local record", async () => {
		const entry = await signedEntry(registryFields(1));
		const retargeted = {
			...entry,
			kmsKeyArns: ["arn:aws:kms:us-east-1:111122223333:key/00000000-0000-4000-8000-0000000000ff"],
		};
		expect(await serviceEntryValidity(retargeted, ACCOUNT, await checked(entry), known(retargeted))).toBe("invalid");
	});

	it("verifies the signature only under the entry's own key id", async () => {
		const entry = await signedEntry(registryFields(1));
		expect(await verifyServiceSig({ ...entry, serviceSig: { ...entry.serviceSig, keyId: "reg-0" } })).toBe(false);
	});

	it("is invalid for an entry of another account, whatever this device recorded", async () => {
		const entry = await signedEntry(registryFields(1));
		expect(await serviceEntryValidity(entry, "other-account", await checked(entry), known(entry))).toBe("invalid");
		expect(await verificationFor(entry, "other-account", 5)).toBeUndefined();
	});

	it("does not accept an attacker key that copies a checked key's ids", async () => {
		const real = await signedEntry(registryFields(1));
		const impostor = await signedEntry(registryFields(1));
		expect(impostor.sigKeyId).toBe(real.sigKeyId);
		expect(await serviceEntryValidity(impostor, ACCOUNT, await checked(real), known(impostor))).toBe("pending");
	});

	it("is unknown while two differently keyed, validly signed entries claim one generation", async () => {
		const real = await signedEntry(registryFields(1));
		const twin = await signedEntry(registryFields(1));
		expect(await serviceEntryValidity(real, ACCOUNT, await checked(real), known(real, twin))).toBe("unknown");
		const forgedTwin = { ...twin, serviceSig: real.serviceSig };
		expect(await serviceEntryValidity(real, ACCOUNT, await checked(real), known(real, forgedTwin))).toBe("valid");
	});

	it("is superseded once this device checked a higher generation that revokes it, and stays so after a roster rollback", async () => {
		const old = await signedEntry(registryFields(1));
		const next = await signedEntry(registryFields(2, old.sigKeyId));
		const records = await checked(old, next);
		expect(await serviceEntryValidity(old, ACCOUNT, records, known(old, next))).toBe("superseded");
		expect(await serviceEntryValidity(old, ACCOUNT, records, known(old))).toBe("superseded");
	});

	it("is not superseded by an unchecked revoker, or by a revoker of an equal or lower generation", async () => {
		const old = await signedEntry(registryFields(2));
		const unchecked = await signedEntry(registryFields(3, old.sigKeyId));
		expect(await serviceEntryValidity(old, ACCOUNT, await checked(old), known(old, unchecked))).toBe("valid");
		const lower = await signedEntry(registryFields(1, old.sigKeyId));
		expect(await serviceEntryValidity(old, ACCOUNT, await checked(old, lower), known(old, lower))).toBe("valid");
	});

	it("is unknown while the roster is unknown", async () => {
		const entry = await signedEntry(registryFields(1));
		expect(await serviceEntryValidity(entry, ACCOUNT, await checked(entry), { state: "unknown" })).toBe("unknown");
	});
});
