import { describe, expect, it } from "vitest";
import { derEcdsaSignatureToP1363, verifyEcdsaP256Sha256 } from "../../src/core/egress/ecdsa-p256.ts";
import {
	parseDeviceKemEntry,
	parseServiceKeyEntry,
	type ServiceKeyEntry,
	serviceEntrySigningPayload,
} from "../../src/core/egress/roster-entries.ts";
import { p1363ToDer, p256Signer, toBase64 } from "./signed-entry.ts";

const P256_N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

function derInteger(magnitude: Uint8Array): Uint8Array {
	let start = 0;
	while (start < magnitude.length - 1 && magnitude[start] === 0) start++;
	const trimmed = magnitude.subarray(start);
	const body = (trimmed[0] ?? 0) & 0x80 ? Uint8Array.of(0, ...trimmed) : trimmed;
	return Uint8Array.of(0x02, body.length, ...body);
}

function bigintTo32(value: bigint): Uint8Array {
	return Uint8Array.from(Buffer.from(value.toString(16).padStart(64, "0"), "hex"));
}

const signer = p256Signer;
const message = new TextEncoder().encode("custody entry bytes");

describe("verifyEcdsaP256Sha256", () => {
	it("accepts a KMS-style DER signature from the matching key", async () => {
		const key = await signer();
		const der = p1363ToDer(await key.sign(message));
		expect(await verifyEcdsaP256Sha256(key.spki, message, toBase64(der))).toBe(true);
	});

	it("refuses a signature over different bytes, or from another key", async () => {
		const key = await signer();
		const other = await signer();
		const der = toBase64(p1363ToDer(await key.sign(message)));
		expect(await verifyEcdsaP256Sha256(key.spki, new TextEncoder().encode("custody entry bytez"), der)).toBe(false);
		expect(await verifyEcdsaP256Sha256(other.spki, message, der)).toBe(false);
	});

	it("accepts the high-S twin, because KMS does not normalise S", async () => {
		const key = await signer();
		const raw = await key.sign(message);
		const s = BigInt(`0x${Buffer.from(raw.subarray(32)).toString("hex")}`);
		const twin = Uint8Array.of(...raw.subarray(0, 32), ...bigintTo32(P256_N - s));
		expect(await verifyEcdsaP256Sha256(key.spki, message, toBase64(p1363ToDer(twin)))).toBe(true);
	});

	it("refuses malformed SPKI and non-base64 input without throwing", async () => {
		const key = await signer();
		const der = toBase64(p1363ToDer(await key.sign(message)));
		expect(await verifyEcdsaP256Sha256("AAAA", message, der)).toBe(false);
		expect(await verifyEcdsaP256Sha256(key.spki, message, "not base64!")).toBe(false);
	});
});

describe("derEcdsaSignatureToP1363", () => {
	const r = new Uint8Array(32).fill(0x11);
	const s = new Uint8Array(32).fill(0x22);
	const canonical = p1363ToDer(Uint8Array.of(...r, ...s));
	const wideR = derInteger(Uint8Array.of(0x01, ...r));
	const sInteger = derInteger(s);

	it("decodes a canonical encoding to r || s", () => {
		expect(derEcdsaSignatureToP1363(canonical)).toEqual(Uint8Array.of(...r, ...s));
	});

	it.each([
		["a trailing byte", Uint8Array.of(...canonical, 0x00)],
		["a wrong sequence length", Uint8Array.of(0x30, (canonical[1] as number) + 1, ...canonical.subarray(2))],
		["a non-minimal zero pad", Uint8Array.of(0x30, 0x45, 0x02, 0x21, 0x00, ...r, ...canonical.subarray(36))],
		["a negative integer", Uint8Array.of(0x30, 0x44, 0x02, 0x20, 0x80, ...r.subarray(1), ...canonical.subarray(36))],
		[
			"an integer wider than the curve order",
			Uint8Array.of(0x30, wideR.length + sInteger.length, ...wideR, ...sInteger),
		],
		["a long-form length", Uint8Array.of(0x30, 0x81, 0x44, ...canonical.subarray(2))],
	])("refuses %s", (_name, der) => {
		expect(derEcdsaSignatureToP1363(der)).toBeUndefined();
	});
});

function custodyEntry(overrides: Partial<Record<keyof ServiceKeyEntry, unknown>> = {}): Record<string, unknown> {
	return {
		kind: "custody",
		accountId: "acct-1",
		generation: 1,
		kemKeyId: "kem-1",
		kemPk: "a2Vt",
		sigKeyId: "sig-1",
		sigPk: "c2ln",
		kmsKeyArns: ["arn:kms:kem", "arn:kms:sig"],
		templateVersion: 1,
		role: "current",
		createdAt: 1,
		serviceSig: { alg: "ECDSA-P256-SHA256", keyId: "sig-1", sig: "c2ln" },
		attestations: [],
		...overrides,
	};
}

describe("parseServiceKeyEntry", () => {
	it("parses custody and superseding placement-registry entries", () => {
		expect(parseServiceKeyEntry(custodyEntry())?.kind).toBe("custody");
		const registry = custodyEntry({ kind: "placement-registry", supersedes: "sig-0", kmsKeyArns: ["arn:kms:reg"] });
		delete registry.kemKeyId;
		delete registry.kemPk;
		expect(parseServiceKeyEntry(registry)?.supersedes).toBe("sig-0");
	});

	it.each([
		["custody without a KEM key", { kemPk: undefined }],
		["custody carrying supersedes", { supersedes: "sig-0" }],
		["a registry entry carrying a KEM key", { kind: "placement-registry" }],
		["an unknown role", { role: "next" }],
		["an unknown field", { extra: true }],
		["a non-integer template version", { templateVersion: 1.5 }],
		["a foreign signature algorithm", { serviceSig: { alg: "RSA", keyId: "sig-1", sig: "c2ln" } }],
	])("refuses %s", (_name, overrides) => {
		const raw = custodyEntry(overrides as Partial<Record<keyof ServiceKeyEntry, unknown>>);
		for (const [key, value] of Object.entries(raw)) if (value === undefined) delete raw[key];
		expect(parseServiceKeyEntry(raw)).toBeUndefined();
	});
});

describe("serviceEntrySigningPayload", () => {
	it("covers every key fact but not serviceSig or the informational attestations", () => {
		const base = parseServiceKeyEntry(custodyEntry());
		const attested = parseServiceKeyEntry(
			custodyEntry({
				attestations: [{ deviceId: "dev-2", checkedAt: 5, sig: "eA==" }],
				serviceSig: { alg: "ECDSA-P256-SHA256", keyId: "sig-1", sig: "b3RoZXI=" },
			}),
		);
		const retargeted = parseServiceKeyEntry(custodyEntry({ kmsKeyArns: ["arn:kms:kem", "arn:kms:other"] }));
		if (!base || !attested || !retargeted) throw new Error("fixture did not parse");
		expect(serviceEntrySigningPayload(attested)).toEqual(serviceEntrySigningPayload(base));
		expect(serviceEntrySigningPayload(retargeted)).not.toEqual(serviceEntrySigningPayload(base));
	});
});

describe("parseDeviceKemEntry", () => {
	const kem = { kind: "device-kem", deviceId: "dev-1", kemPk: "a2Vt", sig: "c2ln" };

	it("parses a device-kem entry", () => {
		expect(parseDeviceKemEntry(kem)).toEqual(kem);
	});

	it.each([
		["another kind", { ...kem, kind: "custody" }],
		["an unknown field", { ...kem, role: "current" }],
		["an empty key", { ...kem, kemPk: "" }],
		["a missing signature", { kind: "device-kem", deviceId: "dev-1", kemPk: "a2Vt" }],
	])("refuses %s", (_name, raw) => {
		expect(parseDeviceKemEntry(raw)).toBeUndefined();
	});
});
