import type { ExtensionAPI } from "../types.ts";

/**
 * The session withholds `bash`, `powershell`, `workflow` and `monitor` from the
 * model's direct tool list exactly when an `eval` tool is registered, so prose
 * surfaces share that one condition instead of each re-deriving it. Registry
 * presence is the session's own gate: a child agent without `eval` keeps the
 * direct tools, and its prompt must keep the direct call shapes.
 */
export function isEvalOnlyRouting(pi: ExtensionAPI): boolean {
	// Prompt rendering must never be what breaks a session: a host that exposes only
	// the handler surface (and any future partial ExtensionAPI) still gets a prompt,
	// falling back to the direct call shapes that are always callable.
	if (typeof pi.getAllTools !== "function") return false;
	return pi.getAllTools().some((tool) => tool.name === "eval");
}
