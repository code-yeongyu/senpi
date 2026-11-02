import type { AgentSessionRuntimeDiagnostic } from "../../core/agent-session-services.ts";
import type { RpcSessionLaunchProfile } from "./session-registry-types.ts";
import { RpcSessionRegistryError } from "./session-registry-types.ts";

/**
 * An `open_session` that names a model must run on it or fail (senpi#2906). The runtime factory
 * reports an unresolvable model only as a diagnostic and falls back to the default model, which the
 * standalone CLI treats as fatal but the host used to ignore.
 */
export function assertRequestedModelResolved(
	profile: Readonly<RpcSessionLaunchProfile>,
	diagnostics: readonly AgentSessionRuntimeDiagnostic[],
): void {
	const requested = profile.creationModel;
	if (requested === undefined) return;
	const unresolved = diagnostics.find((diagnostic) => diagnostic.code === "model_unresolved");
	if (unresolved === undefined) return;
	throw new RpcSessionRegistryError("open_failed", `model_unavailable: ${unresolved.message}`, {
		reason: "model_unavailable",
		requestedModel: `${requested.provider}/${requested.modelId}`,
	});
}
