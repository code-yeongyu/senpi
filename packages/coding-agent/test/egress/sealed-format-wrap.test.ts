import { describe, expect, it } from "vitest";
import { hpkeSealBase, p256Recipient } from "../../src/core/egress/hpke.ts";
import {
	decodeBase64Url,
	HPKE_SUITE,
	type HpkeWrap,
	type KeyedRecipient,
	SealedFormatError,
	unwrapKey,
	type WrapPosition,
	wrapKey,
} from "../../src/core/egress/sealed-format.ts";

const hex = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, "hex"));
const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
	const error = await promise.then(
		() => undefined,
		(caught: unknown) => caught,
	);
	return error instanceof SealedFormatError ? error.code : `not a SealedFormatError: ${String(error)}`;
}

// Two P-256 key pairs from the CFRG HPKE vectors (recipient and ephemeral of mode 0, 0x0010/0x0001/0x0002).
const PK_A = hex(
	"04abc7e49a4c6b3566d77d0304addc6ed0e98512ffccf505e6a8e3eb25c685136f853148544876de76c0f2ef99cdc3a05ccf5ded7860c7c021238f9e2073d2356c",
);
const SK_A = hex("317f915db7bc629c48fe765587897e01e282d3e8445f79f27f65d031a88082b2");
const PK_B = hex(
	"04c06b4f6bebc7bb495cb797ab753f911aff80aefb86fd8b6fcc35525f3ab5f03e0b21bd31a86c6048af3cb2d98e0d3bf01da5cc4c39ff5370d331a4f1f7d5a4e0",
);
const SK_B = hex("90345e3a1d116c1dd39ae76d95ab858c142223a63e44f8f85318cfa91a84858e");

const keyed = async (sk: Uint8Array, pk: Uint8Array, keyId: string): Promise<KeyedRecipient> => ({
	...(await p256Recipient(sk, pk)),
	keyId,
});
const KEY = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const POSITION: WrapPosition = { account: "acct-1", kind: "dek", id: "dek-1" };

describe("HPKE key wraps with a rebuilt WrapAad and per-kind info", () => {
	it("opens a wrap built from the pinned info and AAD strings by the bare primitive", async () => {
		const sealed = await hpkeSealBase(PK_A, {
			info: utf8("omo-custody/wrap/v1/dek"),
			aad: utf8(
				'omo-custody/wrap-aad/v1\u0000{"account":"acct-1","id":"dek-1","kind":"dek","recipientKeyId":"ck-current"}',
			),
			pt: KEY,
		});
		const wrap: HpkeWrap = { suite: HPKE_SUITE, enc: b64u(sealed.enc), ct: b64u(sealed.ct) };
		expect(await unwrapKey(await keyed(SK_A, PK_A, "ck-current"), POSITION, wrap)).toEqual(KEY);
	});

	it("round-trips and stores no AAD", async () => {
		const wrap = await wrapKey(PK_A, { ...POSITION, recipientKeyId: "ck-current" }, KEY);
		expect(Object.keys(wrap).sort()).toEqual(["ct", "enc", "suite"]);
		expect(await unwrapKey(await keyed(SK_A, PK_A, "ck-current"), POSITION, wrap)).toEqual(KEY);
	});

	it.each(["cfg", "proj"] as const)("refuses a dek wrap presented as a %s wrap", async (kind) => {
		const wrap = await wrapKey(PK_A, { ...POSITION, recipientKeyId: "ck-current" }, KEY);
		const recipient = await keyed(SK_A, PK_A, "ck-current");
		expect(await codeOf(unwrapKey(recipient, { ...POSITION, kind }, wrap))).toBe("open_failed");
	});

	it("refuses a wrap made for the standby key id when opened under the current key id with the same DH key", async () => {
		const wrap = await wrapKey(PK_A, { ...POSITION, recipientKeyId: "ck-standby" }, KEY);
		expect(await codeOf(unwrapKey(await keyed(SK_A, PK_A, "ck-current"), POSITION, wrap))).toBe("open_failed");
	});

	it("ignores any AAD a stored wrap carries", async () => {
		const wrap = await wrapKey(PK_A, { ...POSITION, recipientKeyId: "ck-standby" }, KEY);
		const tampered = { ...wrap };
		Reflect.set(tampered, "aad", { ...POSITION, recipientKeyId: "ck-standby" });
		expect(await codeOf(unwrapKey(await keyed(SK_A, PK_A, "ck-current"), POSITION, tampered))).toBe("open_failed");
	});

	it("refuses another account, id, recipient key, truncation and an unknown suite", async () => {
		const wrap = await wrapKey(PK_A, { ...POSITION, recipientKeyId: "ck-current" }, KEY);
		const recipient = await keyed(SK_A, PK_A, "ck-current");
		expect(await codeOf(unwrapKey(recipient, { ...POSITION, account: "acct-2" }, wrap))).toBe("open_failed");
		expect(await codeOf(unwrapKey(recipient, { ...POSITION, id: "dek-2" }, wrap))).toBe("open_failed");
		expect(await codeOf(unwrapKey(await keyed(SK_B, PK_B, "ck-current"), POSITION, wrap))).toBe("open_failed");
		const ct = Buffer.from(wrap.ct, "base64url");
		expect(await codeOf(unwrapKey(recipient, POSITION, { ...wrap, ct: b64u(ct.subarray(0, -1)) }))).toBe(
			"open_failed",
		);
		const other = { ...wrap };
		Reflect.set(other, "suite", "DHKEM(X25519,HKDF-SHA256)/HKDF-SHA256/AES-256-GCM");
		expect(await codeOf(unwrapKey(recipient, POSITION, other))).toBe("unsupported_version");
	});
});

describe("strict base64url", () => {
	it("accepts the canonical form only", () => {
		expect(decodeBase64Url("AA")).toEqual(new Uint8Array([0]));
		for (const bad of ["AA==", "A", "AB", "A+", "A/"]) expect(() => decodeBase64Url(bad)).toThrow(SealedFormatError);
	});
});
