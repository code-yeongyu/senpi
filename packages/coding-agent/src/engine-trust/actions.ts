/**
 * The one action catalog every trust surface shows (CLI line, RPC `trust` field, shim notice,
 * `omo doctor`), keyed by the fallback reason or the refusal code (omo#10762, design r13 6.6).
 * Every action is diagnostic or repair. None disables verification, enables Bun's system store,
 * or tells the user to trust a certificate.
 */
import type { ENGINE_TRUST_FALLBACK_REASONS } from "./marker.ts";

export type EngineTrustActionReason =
	| (typeof ENGINE_TRUST_FALLBACK_REASONS)[number]
	| "trust-path-unrepresentable"
	| "trust-user-extras-unrecoverable";

export type EngineTrustActionId =
	| "reinstall-omo"
	| "retry-after-store-ready"
	| "check-store-access"
	| "report-helper-failure"
	| "regenerate-system-bundle"
	| "set-tmpdir"
	| "fix-extra-ca-variable";

export type EngineTrustAction = { readonly id: EngineTrustActionId; readonly text: string };

const ACTIONS: Readonly<Record<EngineTrustActionId, string>> = {
	"reinstall-omo":
		"Reinstall or update omo (omo update; desktop: install the current app). The certificate helper is missing or damaged.",
	"retry-after-store-ready":
		"Run omo trust ensure --wait, then restart the session. The OS certificate store answered too slowly.",
	"check-store-access": "Run omo doctor, which names the store or registry value that could not be read.",
	"report-helper-failure":
		"Run omo doctor and attach its output to a bug report; reinstalling omo (omo update) may repair the helper.",
	"regenerate-system-bundle":
		"Run your distribution's update-ca-certificates or update-ca-trust. The generated TLS bundle could not be read.",
	"set-tmpdir":
		"Both the trust directory and the temporary directory contain a character this platform cannot pass in SSL_CERT_DIR. Set TMPDIR (Windows: TMP) to a path without : (Windows: ;) and start omo again.",
	"fix-extra-ca-variable": "Point NODE_EXTRA_CA_CERTS at your own CA file, or unset it.",
};

const ACTION_FOR: Readonly<Record<EngineTrustActionReason, EngineTrustActionId>> = {
	"helper-missing": "reinstall-omo",
	"helper-wrong-arch": "reinstall-omo",
	"helper-signature": "reinstall-omo",
	"helper-timeout": "retry-after-store-ready",
	"access-denied": "check-store-access",
	"negatives-incomplete": "check-store-access",
	"helper-crash": "report-helper-failure",
	"helper-malformed-output": "report-helper-failure",
	"linux-bundle-unreadable": "regenerate-system-bundle",
	"linux-bundle-malformed": "regenerate-system-bundle",
	"trust-path-unrepresentable": "set-tmpdir",
	"trust-user-extras-unrecoverable": "fix-extra-ca-variable",
};

export function engineTrustAction(reason: EngineTrustActionReason): EngineTrustAction {
	const id = ACTION_FOR[reason];
	return { id, text: ACTIONS[id] };
}
