import {
	type ConnectionOrigin,
	clearDelegatedRun,
	type DelegatedRunMark,
	noteDelegatedRun,
} from "../../core/turn-origin.ts";
import { classifyRpcMethod, type RpcMethodClass } from "./method-classes.ts";

const ACTING_CLASSES: ReadonlySet<RpcMethodClass> = new Set(["drive", "device_admin"]);

/**
 * Marks a session as remote-driven when a delegated connection sends it any record that can act on its work, decided
 * by the engine's own method-class table (`drive`, and `device_admin`, which grants more), never by a hand-kept list of
 * commands, so a new run starter (`continue_from_leaf`, `wake`, `resume_for_run`, ...) cannot slip past the rule.
 */
export function noteDelegatedRecord(
	command: object,
	origin: ConnectionOrigin,
	sessionManager: object,
): DelegatedRunMark | undefined {
	const methodClass = classifyRpcMethod(command);
	if (methodClass === undefined || !ACTING_CLASSES.has(methodClass)) return undefined;
	if (origin === "delegated") return noteDelegatedRun(sessionManager, command);
	clearDelegatedRun(sessionManager);
	return undefined;
}
