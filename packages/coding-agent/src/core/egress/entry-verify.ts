import { strictEd25519Verify } from "../../modes/rpc/ed25519-strict.ts";

export const ENTRY_SIG_DOMAIN = "omo-custody/provider-entry/v1";

const LOWER_HEX = /^[0-9a-f]+$/u;
const BASE64URL_NO_PAD = /^[A-Za-z0-9_-]+$/u;
const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

/** r11.1 C.P5: entrySig signs ASCII(domain) || 0x00 || ASCII(entryDigest), entryDigest in lowercase hex. */
export function entrySigPayload(entryDigest: string): Uint8Array {
	if (!LOWER_HEX.test(entryDigest)) throw new TypeError("entryDigest must be lowercase hexadecimal");
	const domain = Buffer.from(ENTRY_SIG_DOMAIN, "ascii");
	return new Uint8Array(Buffer.concat([domain, Buffer.from([0]), Buffer.from(entryDigest, "ascii")]));
}

function decodeSignature(entrySig: string): Uint8Array | undefined {
	if (!BASE64URL_NO_PAD.test(entrySig)) return undefined;
	const bytes = Buffer.from(entrySig, "base64url");
	if (bytes.length !== ED25519_SIGNATURE_BYTES || bytes.toString("base64url") !== entrySig) return undefined;
	return new Uint8Array(bytes);
}

export interface EntrySigInput {
	readonly entryDigest: string;
	/** Canonical base64url without padding. */
	readonly entrySig: string;
	/** The owner's enrolled Ed25519 public key (32 raw bytes). */
	readonly ownerPublicKey: Uint8Array;
}

/** The brain-side check before dialing (custody design 3.2); a false result is a wait, never a dial. */
export async function verifyEntrySig(input: EntrySigInput): Promise<boolean> {
	if (input.ownerPublicKey.length !== ED25519_PUBLIC_KEY_BYTES) return false;
	if (!LOWER_HEX.test(input.entryDigest)) return false;
	const signature = decodeSignature(input.entrySig);
	if (signature === undefined) return false;
	return strictEd25519Verify(input.ownerPublicKey, entrySigPayload(input.entryDigest), signature);
}
