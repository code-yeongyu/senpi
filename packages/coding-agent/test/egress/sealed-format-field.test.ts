import { describe, expect, it } from "vitest";
import {
	aes256GcmOpen,
	type ConfigEnvelope,
	configAadBytes,
	type FieldAad,
	fieldAadBytes,
	openConfig,
	openField,
	parseDekId,
	parseSourceDigest,
	type SealedField,
	SealedFormatError,
	sealConfig,
	sealField,
	wrapAadBytes,
} from "../../src/core/egress/sealed-format.ts";

const hex = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, "hex"));
const b64u = (hexValue: string): string => Buffer.from(hexValue, "hex").toString("base64url");
const utf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
	const error = await promise.then(
		() => undefined,
		(caught: unknown) => caught,
	);
	return error instanceof SealedFormatError ? error.code : `not a SealedFormatError: ${String(error)}`;
}

function withMember<T extends object>(value: T, key: string, member: unknown): T {
	const copy = { ...value };
	Reflect.set(copy, key, member);
	return copy;
}

// Vectors below were produced by node:crypto createCipheriv from hand-written AAD strings, not by the code under test.
const DEK = Uint8Array.from({ length: 32 }, (_, index) => index);
const VECTOR_NONCE = "000102030405060708090a0b";
const AAD: FieldAad = {
	account: "acct-1",
	provider: "openai",
	owner: "device-a",
	sourceDigest: parseSourceDigest("sha256:ab12"),
	field: "apiKey",
	dekId: parseDekId("dek-1"),
};
const FIELD_AAD_TEXT =
	'omo-custody/field-aad/v1\u0000{"account":"acct-1","dekId":"dek-1","field":"apiKey","owner":"device-a","provider":"openai","sourceDigest":"sha256:ab12"}';
const FIELD_CT = "3469fb6fa096b636e32ee3a6d0c40a08e2baaa5f9502db26fb7ec0b205ac02436716fc5a19bd";
const FIELD_CT_V0_LABEL = "3469fb6fa096b636e32ee3a6d0c40a08e2baaa5f95022150293ade36bc41821e9f703ad42322";
const META = { source: "literal", resolvedAt: 1, refreshable: false } as const;
const vectorField = (ct: string): SealedField => ({
	v: 1,
	state: "sealed",
	nonce: b64u(VECTOR_NONCE),
	ct: b64u(ct),
	meta: META,
});

describe("raw AES-256-GCM (NIST GCM spec test case 16: 256-bit key, 96-bit IV, AAD)", () => {
	it("opens the published ciphertext", async () => {
		const pt = await aes256GcmOpen(
			hex("feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308"),
			hex("cafebabefacedbaddecaf888"),
			hex("feedfacedeadbeeffeedfacedeadbeefabaddad2"),
			hex(
				"522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f66276fc6ece0f4e1768cddf8853bb2d551b",
			),
		);
		expect(Buffer.from(pt).toString("hex")).toBe(
			"d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39",
		);
	});
});

describe("SealedField under the provider DEK with the rebuilt FieldAad", () => {
	it("encodes the FieldAad as label, NUL, sorted canonical JSON", () => {
		expect(utf8(fieldAadBytes(AAD))).toBe(FIELD_AAD_TEXT);
	});

	it("opens the build-order vector: (account, provider, owner, sourceDigest, field, dekId, DEK, nonce, pt) -> ct", async () => {
		expect(utf8(await openField(DEK, AAD, vectorField(FIELD_CT)))).toBe("sk-test-not-a-real-key");
	});

	it.each(["account", "provider", "owner", "sourceDigest", "field", "dekId"])(
		"refuses the vector when only %s differs",
		async (member) => {
			const other = withMember(
				AAD,
				member,
				member === "field" ? "credential:0" : `${String(Reflect.get(AAD, member))}x`,
			);
			expect(await codeOf(openField(DEK, other, vectorField(FIELD_CT)))).toBe("open_failed");
		},
	);

	it("round-trips with a fresh CSPRNG nonce on every seal", async () => {
		const first = await sealField(DEK, AAD, "sk-test-not-a-real-key", META);
		const second = await sealField(DEK, AAD, "sk-test-not-a-real-key", META);
		expect(Buffer.from(first.nonce, "base64url")).toHaveLength(12);
		expect(first.nonce).not.toBe(second.nonce);
		expect(first.ct).not.toBe(second.ct);
		expect(utf8(await openField(DEK, AAD, first))).toBe("sk-test-not-a-real-key");
	});

	it("never seals an empty secret", async () => {
		expect(await codeOf(sealField(DEK, AAD, "", META))).toBe("empty_secret");
	});

	it("refuses a wrong DEK, a truncated or flipped ciphertext, and an unresolved field", async () => {
		const wrongDek = Uint8Array.from(DEK, (byte) => byte ^ 0xff);
		expect(await codeOf(openField(wrongDek, AAD, vectorField(FIELD_CT)))).toBe("open_failed");
		expect(await codeOf(openField(DEK, AAD, vectorField(FIELD_CT.slice(0, -2))))).toBe("open_failed");
		expect(await codeOf(openField(DEK, AAD, vectorField(FIELD_CT.slice(0, 30))))).toBe("open_failed");
		expect(await codeOf(openField(DEK, AAD, vectorField(`ff${FIELD_CT.slice(2)}`)))).toBe("open_failed");
		const unresolved: SealedField = {
			v: 1,
			state: "unresolved",
			meta: { source: "env", attemptedAt: 1, refreshable: true },
		};
		expect(await codeOf(openField(DEK, AAD, unresolved))).toBe("open_failed");
	});

	it("refuses another format version before any crypto, and a ciphertext bound to another label version", async () => {
		for (const v of [0, 2, "1"]) {
			expect(await codeOf(openField(DEK, AAD, withMember(vectorField(FIELD_CT), "v", v)))).toBe(
				"unsupported_version",
			);
		}
		expect(await codeOf(openField(DEK, AAD, vectorField(FIELD_CT_V0_LABEL)))).toBe("open_failed");
	});

	it("refuses a DEK that is not 256 bits", async () => {
		expect(await codeOf(sealField(DEK.subarray(0, 16), AAD, "x", META))).toBe("invalid_key");
	});
});

describe("config object under K_cfg, AAD {accountId, version, cfgKeyId}", () => {
	const envelope = (ct: string, version = 7): ConfigEnvelope => ({
		v: 1,
		accountId: "acct-1",
		version,
		cfgKeyId: "cfg-1",
		cfg: { nonce: b64u(VECTOR_NONCE), ct: b64u(ct) },
	});
	const CFG_CT = "3c20a039ffd4bffbab8899e7dd4e89b2ab34e85f6bf3ea";

	it("opens the independent vector and refuses it at another version, key id or format version", async () => {
		expect(utf8(await openConfig(DEK, envelope(CFG_CT)))).toBe('{"v":1}');
		expect(await codeOf(openConfig(DEK, envelope(CFG_CT, 8)))).toBe("open_failed");
		expect(await codeOf(openConfig(DEK, { ...envelope(CFG_CT), cfgKeyId: "cfg-2" }))).toBe("open_failed");
		expect(await codeOf(openConfig(DEK, withMember(envelope(CFG_CT), "v", 2)))).toBe("unsupported_version");
	});

	it("round-trips, and a field ciphertext presented as the object does not open", async () => {
		const aad = { accountId: "acct-1", version: 3, cfgKeyId: "cfg-1" };
		const cfg = await sealConfig(DEK, aad, new TextEncoder().encode("{}"));
		expect(utf8(await openConfig(DEK, { v: 1, ...aad, cfg }))).toBe("{}");
		const field = await sealField(DEK, AAD, "{}", META);
		expect(await codeOf(openConfig(DEK, { v: 1, ...aad, cfg: field }))).toBe("open_failed");
	});
});

describe("AAD builders accept only the injective domain", () => {
	const wrap = { account: "acct-1", kind: "dek", id: "dek-1", recipientKeyId: "ck-1" } as const;
	const cfg = { accountId: "acct-1", version: 7, cfgKeyId: "cfg-1" };

	it.each([undefined, Number.NaN, new Uint8Array(1), null, 1])("refuses %s as a string member", (bad) => {
		expect(() => fieldAadBytes(withMember(AAD, "owner", bad))).toThrow(SealedFormatError);
		expect(() => wrapAadBytes(withMember(wrap, "id", bad))).toThrow(SealedFormatError);
	});

	it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1, "7", new Uint8Array(1)])(
		"refuses %s as the config version",
		(bad) => {
			expect(() => configAadBytes(withMember(cfg, "version", bad))).toThrow(SealedFormatError);
		},
	);

	it("produces label, NUL and JSON that round-trips with no undefined", () => {
		for (const bytes of [fieldAadBytes(AAD), wrapAadBytes(wrap), configAadBytes(cfg)]) {
			const [label, json, ...rest] = utf8(bytes).split("\u0000");
			expect(rest).toEqual([]);
			expect(label).toMatch(/^omo-custody\/(field|wrap|cfg)-aad\/v1$/);
			expect(json).not.toContain("undefined");
			expect(JSON.stringify(JSON.parse(json ?? ""))).toBe(json);
		}
	});

	it("parses source digests and dekIds only at the boundary", () => {
		expect(() => parseSourceDigest("")).toThrow(SealedFormatError);
		expect(() => parseSourceDigest("sha256 ab")).toThrow(SealedFormatError);
		expect(() => parseDekId("dek/1")).toThrow(SealedFormatError);
		expect(parseDekId("dek_1-A")).toBe("dek_1-A");
	});
});
