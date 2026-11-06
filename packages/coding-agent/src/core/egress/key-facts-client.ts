/**
 * Key facts the device-side key check consumes (custody design 3.1, CK28).
 *
 * The facts channel needs a trust anchor the device ships with (custody design section 15, being amended):
 * an HTTPS read validated only by the host's CA store can be forged by anyone who interposes TLS, and a
 * forged "ok" would let a device wrap its keys to an attacker key. Until that anchor is designed, the only
 * reader is `UNANCHORED_KEY_FACTS_READER`, which answers `"unknown"` for every key, so no check can pass.
 */

export interface KmsKeyFacts {
	readonly spki: string;
	readonly origin: "AWS_KMS" | "EXTERNAL" | "AWS_CLOUDHSM" | "EXTERNAL_KEY_STORE";
	readonly keySpec: string;
	readonly keyUsage: "KEY_AGREEMENT" | "SIGN_VERIFY" | "ENCRYPT_DECRYPT";
	readonly keyManager: "CUSTOMER" | "AWS";
	readonly keyState: string;
	readonly multiRegion: boolean;
	readonly tags: Readonly<Record<string, string>>;
	/** JSON of GetKeyPolicy; the check re-canonicalizes it before comparing. */
	readonly policy: string;
	readonly grantCount: number;
	/** When the verifier read these facts upstream (ms since epoch). */
	readonly readAt: number;
}

export interface KmsKeyReader {
	describe(keyArn: string): Promise<KmsKeyFacts | "unknown">;
}

export const MAX_FACTS_AGE_MS = 120_000;
export const MAX_FACTS_FUTURE_SKEW_MS = 30_000;

export const UNANCHORED_KEY_FACTS_READER: KmsKeyReader = {
	async describe() {
		return "unknown";
	},
};
