import type { ConnectionOrigin } from "../../core/turn-origin.ts";
import { classifyRpcMethod, type RpcMethodClass } from "./method-classes.ts";

const ACTING_CLASSES: ReadonlySet<RpcMethodClass> = new Set(["drive", "device_admin"]);

/**
 * The origin a record's own handling runs under (senpi#6342): delegated for a cross-account record that can act on the
 * session's work, decided by the engine's own method-class table (`drive`, and `device_admin`, which grants more),
 * never by a hand-kept list of commands, so a new run starter (`continue_from_leaf`, `wake`, `resume_for_run`, ...)
 * cannot slip past the rule. Any other record runs as local.
 */
export function recordTurnOrigin(command: object, origin: ConnectionOrigin): ConnectionOrigin {
	if (origin !== "delegated") return "local";
	const methodClass = classifyRpcMethod(command);
	return methodClass !== undefined && ACTING_CLASSES.has(methodClass) ? "delegated" : "local";
}
