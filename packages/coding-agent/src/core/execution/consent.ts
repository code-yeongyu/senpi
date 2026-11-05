import type { ConsentClassifier } from "@earendil-works/pi-agent-core";

/** A permission decision for one call, as the permission system's dispatch policy computes it without prompting. */
export type PermissionAction = "allow" | "ask" | "deny";

/**
 * The executor's Gate B classifier over a permission policy (design 5.6.1): only `ask` needs consent. `deny` is not
 * consent: the call's own `tool_call` chain refuses it, as today. Only a cross-machine executor is given one (K3).
 */
export function consentFromPermissionPolicy(
	policy: (call: { readonly name: string; readonly args: unknown }) => PermissionAction,
): ConsentClassifier {
	return { needsConsent: (call) => policy(call) === "ask" };
}
