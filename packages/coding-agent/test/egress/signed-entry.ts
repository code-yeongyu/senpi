import { type ServiceKeyEntry, serviceEntrySigningPayload } from "../../src/core/egress/roster-entries.ts";

export function toBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

function derInteger(magnitude: Uint8Array): number[] {
	let start = 0;
	while (start < magnitude.length - 1 && magnitude[start] === 0) start++;
	const trimmed = [...magnitude.subarray(start)];
	const body = (trimmed[0] ?? 0) & 0x80 ? [0, ...trimmed] : trimmed;
	return [0x02, body.length, ...body];
}

/** IEEE P1363 `r || s` -> DER, the encoding KMS `Sign` returns. */
export function p1363ToDer(signature: Uint8Array): Uint8Array {
	const r = derInteger(signature.subarray(0, 32));
	const s = derInteger(signature.subarray(32));
	return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]);
}

export interface P256Signer {
	readonly spki: string;
	sign(message: Uint8Array<ArrayBuffer>): Promise<Uint8Array>;
}

export async function p256Signer(): Promise<P256Signer> {
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	return {
		spki: toBase64(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))),
		sign: async (message) =>
			new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, message)),
	};
}

export type EntryFields = Omit<ServiceKeyEntry, "sigPk" | "serviceSig" | "attestations">;

/** An entry self-signed by a fresh key (or `signer`), exactly as the Custody Service would publish it. */
export async function signedEntry(fields: EntryFields, signer?: P256Signer): Promise<ServiceKeyEntry> {
	const key = signer ?? (await p256Signer());
	const unsigned: ServiceKeyEntry = {
		...fields,
		sigPk: key.spki,
		serviceSig: { alg: "ECDSA-P256-SHA256", keyId: fields.sigKeyId, sig: "" },
		attestations: [],
	};
	const sig = toBase64(p1363ToDer(await key.sign(serviceEntrySigningPayload(unsigned))));
	return { ...unsigned, serviceSig: { ...unsigned.serviceSig, sig } };
}

export const registryFields = (generation: number, supersedes?: string): EntryFields => ({
	kind: "placement-registry",
	accountId: "omo-account",
	generation,
	sigKeyId: `reg-${generation}`,
	kmsKeyArns: [`arn:aws:kms:us-east-1:111122223333:key/00000000-0000-4000-8000-00000000000${generation}`],
	templateVersion: 1,
	role: "current",
	createdAt: generation,
	...(supersedes ? { supersedes } : {}),
});
