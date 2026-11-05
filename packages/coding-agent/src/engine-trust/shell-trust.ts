/**
 * The trust annotation on agent-shell results (omo#10762, design r13 6.7). Under a fallback generation a
 * command that exits non-zero carries a trusted status taken from the adopted record and, only when its
 * output looks like a certificate verification error, an untrusted hint naming the matched catalog pattern.
 * The output never supplies a reason or an action: any command can print any text, including a forged
 * Bun footer or trust line (design M16). Like `adopted.ts`, this module does not load the marker parser.
 */
import { type EngineTrustActionId, engineTrustAction } from "./actions.ts";
import { adoptedEngineTrust } from "./adopted.ts";
import type { ENGINE_TRUST_FALLBACK_REASONS } from "./marker.ts";

/** A verification code (design 6.6) as a whole token, whatever quotes surround it. */
const token = (code: string): RegExp => new RegExp(`(?<![A-Za-z0-9_])${code}(?![A-Za-z0-9_])`, "u");

/** Catalog order decides which entry a hint names when several match. */
const SHELL_TRUST_PATTERNS = [
	["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", token("UNABLE_TO_GET_ISSUER_CERT_LOCALLY")],
	["UNABLE_TO_GET_ISSUER_CERT", token("UNABLE_TO_GET_ISSUER_CERT")],
	["UNABLE_TO_VERIFY_LEAF_SIGNATURE", token("UNABLE_TO_VERIFY_LEAF_SIGNATURE")],
	["SELF_SIGNED_CERT_IN_CHAIN", token("SELF_SIGNED_CERT_IN_CHAIN")],
	["DEPTH_ZERO_SELF_SIGNED_CERT", token("DEPTH_ZERO_SELF_SIGNED_CERT")],
	["CERT_UNTRUSTED", token("CERT_UNTRUSTED")],
	["unable-to-verify-the-first-certificate", /unable to verify the first certificate/iu],
	["unable-to-get-local-issuer-certificate", /unable to get local issuer certificate/iu],
	["unable-to-get-issuer-certificate", /unable to get issuer certificate/iu],
	["self-signed-certificate-in-certificate-chain", /self[- ]signed certificate in certificate chain/iu],
	["self-signed-certificate", /self[- ]signed certificate/iu],
	["certificate-not-trusted", /certificate not trusted/iu],
] as const;

export type ShellTrustPatternId = (typeof SHELL_TRUST_PATTERNS)[number][0];

export type ShellTrust = {
	readonly status: {
		readonly code: "trust-import-degraded";
		readonly reason: (typeof ENGINE_TRUST_FALLBACK_REASONS)[number];
		readonly action: EngineTrustActionId;
	};
	readonly hint?: {
		readonly code: "tls-verify-text-in-output";
		readonly heuristic: true;
		readonly pattern: ShellTrustPatternId;
	};
};

export type ShellTrustAnnotation = {
	readonly trust: ShellTrust;
	/** The one fixed line appended for the model, only with a hint; it never echoes output. */
	readonly text: string | undefined;
};

/** Nothing without an adopted fallback generation, on exit 0, or for a command that has no exit code. */
export function annotateShellTrust({
	exitCode,
	output,
}: {
	readonly exitCode: number | null;
	readonly output: string;
}): ShellTrustAnnotation | undefined {
	const marker = adoptedEngineTrust();
	if (marker?.automatic !== "fallback" || marker.fallbackReason === null || exitCode === null || exitCode === 0) {
		return undefined;
	}
	const reason = marker.fallbackReason;
	const action = engineTrustAction(reason);
	const status = { code: "trust-import-degraded", reason, action: action.id } as const;
	const pattern = SHELL_TRUST_PATTERNS.find(([, matcher]) => matcher.test(output))?.[0];
	if (pattern === undefined) return { trust: { status }, text: undefined };
	return {
		trust: { status, hint: { code: "tls-verify-text-in-output", heuristic: true, pattern } },
		text: `omo: certificate import is degraded (${reason}), so some TLS connections may fail. This command's output contains text that looks like a certificate verification error; omo has not confirmed the cause. To diagnose: ${action.text}`,
	};
}
