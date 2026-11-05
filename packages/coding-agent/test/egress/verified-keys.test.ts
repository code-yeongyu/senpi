import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	findVerification,
	type LocalKeyVerification,
	readVerifiedKeys,
	recordVerification,
	serviceEntryValidity,
	verificationFor,
	verifiedKeysPath,
} from "../../src/core/egress/verified-keys.ts";
import { FileLockLostError } from "../../src/core/file-lock.ts";
import { p256Signer, registryFields, signedEntry } from "./signed-entry.ts";

let root: string;
let path: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ck11-verified-keys-"));
	path = verifiedKeysPath(root);
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

const record: LocalKeyVerification = {
	kind: "custody",
	accountId: "omo-account",
	generation: 1,
	sigKeyId: "sig-1",
	sigPkSha256: "c2lnLWhhc2g=",
	kemKeyId: "kem-1",
	kemPkSha256: "a2VtLWhhc2g=",
	kmsKeyArns: ["arn:kem", "arn:sig"],
	templateVersion: 1,
	verifierKeyId: "verifier-1",
	vouchedAt: 9,
	checkedAt: 10,
};
const vouch = { verifierKeyId: "verifier-1", vouchedAt: 6 };

describe("verified-keys store", () => {
	it("lives under <agentDir>/state/custody/verified-keys.json", () => {
		expect(path).toBe(join(root, "state", "custody", "verified-keys.json"));
	});

	it("reads a missing file as no records", async () => {
		expect(await readVerifiedKeys(path)).toEqual({ state: "ok", records: [] });
	});

	it.each([
		["unparseable JSON", "{"],
		["the id-only version 1 format", JSON.stringify({ v: 1, records: [] })],
		["a record with an unknown field", JSON.stringify({ v: 2, records: [{ ...record, trusted: true }] })],
		["a record without key hashes", JSON.stringify({ v: 2, records: [{ ...record, sigPkSha256: undefined }] })],
		["a record with a non-integer generation", JSON.stringify({ v: 2, records: [{ ...record, generation: "1" }] })],
		[
			"a record with a verifier key id but no vouch time",
			JSON.stringify({ v: 2, records: [{ ...record, vouchedAt: undefined }] }),
		],
	])("reads %s as unknown, so it grants nothing", async (_name, text) => {
		await mkdir(dirname(path), { recursive: true });
		writeFileSync(path, text);
		expect(await readVerifiedKeys(path)).toEqual({ state: "unknown" });
	});

	it("reads a record without a verifier key id as absent, so the device checks the key again", async () => {
		const { verifierKeyId: _verifier, vouchedAt: _vouched, ...unvouched } = record;
		await mkdir(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ v: 2, records: [unvouched, record] }));
		expect(await readVerifiedKeys(path)).toEqual({ state: "ok", records: [record] });
	});

	it("writes a 0600 file and reads the record back", async () => {
		await recordVerification(path, record);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(await readVerifiedKeys(path)).toEqual({ state: "ok", records: [record] });
	});

	it("replaces an earlier record for the same key and keeps the others", async () => {
		const other: LocalKeyVerification = { ...record, kind: "placement-registry", sigKeyId: "reg-3", generation: 3 };
		await recordVerification(path, record);
		await recordVerification(path, other);
		await recordVerification(path, { ...record, checkedAt: 99 });
		expect(await readVerifiedKeys(path)).toEqual({ state: "ok", records: [other, { ...record, checkedAt: 99 }] });
	});

	it("keeps a revocation when the revoking key is re-checked from an entry without supersedes", async () => {
		const old = await signedEntry(registryFields(1));
		const signer = await p256Signer();
		const revoker = await signedEntry(registryFields(2, old.sigKeyId), signer);
		const reissued = await signedEntry(registryFields(2), signer);
		for (const entry of [old, revoker, reissued]) {
			const checked = await verificationFor(entry, "omo-account", 7, vouch);
			if (!checked) throw new Error("fixture did not record");
			await recordVerification(path, checked);
		}
		const read = await readVerifiedKeys(path);
		if (read.state !== "ok") throw new Error("store unreadable");
		const roster = { state: "known" as const, serviceEntries: [old, reissued] };
		expect(await serviceEntryValidity(old, "omo-account", read.records, roster)).toBe("superseded");
		expect(await serviceEntryValidity(reissued, "omo-account", read.records, roster)).toBe("valid");
	});

	it("replaces an unreadable file instead of failing the check that just passed", async () => {
		await mkdir(dirname(path), { recursive: true });
		writeFileSync(path, "{");
		await recordVerification(path, record);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ v: 2, records: [record] });
	});

	it("writes nothing more once its lock is lost: no temp file, the stored records unchanged, a typed error", async () => {
		await recordVerification(path, record);
		const before = readFileSync(path, "utf8");
		const realLock = lockfile.lock;
		vi.spyOn(lockfile, "lock").mockImplementation(async (file, options) => {
			const release = await realLock(file, options);
			await release();
			options?.onCompromised?.(Object.assign(new Error("lock reclaimed"), { code: "ECOMPROMISED" }));
			return async () => {};
		});

		await expect(recordVerification(path, { ...record, generation: 2 })).rejects.toBeInstanceOf(FileLockLostError);
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});
});

describe("verificationFor / findVerification", () => {
	it("binds the account, the key hashes, the ARNs and the template version", async () => {
		const entry = await signedEntry(registryFields(1));
		const bound = await verificationFor(entry, "omo-account", 7, vouch);
		expect(bound).toMatchObject({
			accountId: "omo-account",
			kmsKeyArns: entry.kmsKeyArns,
			templateVersion: 1,
			verifierKeyId: "verifier-1",
			vouchedAt: 6,
			checkedAt: 7,
		});
		expect(bound?.sigPkSha256).toMatch(/^[A-Za-z0-9+/]{43}=$/);
	});

	it("matches the checked entry, and nothing that differs in key, ARNs, template or generation", async () => {
		const entry = await signedEntry(registryFields(1));
		const stored = await verificationFor(entry, "omo-account", 7, vouch);
		if (!stored) throw new Error("fixture did not record");
		expect(await findVerification([stored], entry)).toEqual(stored);
		const sameIdsOtherKey = await signedEntry(registryFields(1));
		expect(await findVerification([stored], sameIdsOtherKey)).toBeUndefined();
		for (const changed of [
			{ ...stored, kmsKeyArns: ["arn:other"] },
			{ ...stored, templateVersion: 2 },
			{ ...stored, generation: 2 },
			{ ...stored, accountId: "other-account" },
		]) {
			expect(await findVerification([changed], entry)).toBeUndefined();
		}
	});
});
