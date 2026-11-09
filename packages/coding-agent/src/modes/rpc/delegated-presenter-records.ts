/**
 * Private presenter records and presenter control discovery on the delegated-connection gate (senpi#4249 R-1b d1,
 * d2). Outside `RPC_METHOD_CLASS`, so its digest is unchanged: a forwarder that pins it keeps working.
 */
import type { RpcMethodClass } from "./method-classes.ts";
import type { DelegationVerdict } from "./delegation-wire.ts";

export const PRESENTER_CONTROL_INFO_COMMAND = "mcp_presenter_control_info";

/** The presenter client records the private handler takes (`session-event-writer.ts`, `mcp-presenter-forms.ts`). */
const PRESENTER_CLIENT_RECORDS: ReadonlySet<string> = new Set([
	"mcp_presenter_context",
	"mcp_form_presented",
	"mcp_form_response",
	"mcp_form_sync",
]);

/** A type a forwarder routes as private: its answer is always the private reply shape on a delegated connection. */
export function isPrivatePresenterType(type: unknown): type is string {
	return typeof type === "string" && (type.startsWith("mcp_form_") || type.startsWith("mcp_presenter_"));
}

export function privatePresenterVerdict(
	type: string,
	id: string | undefined,
	granted: ReadonlySet<RpcMethodClass>,
): DelegationVerdict {
	if (type === PRESENTER_CONTROL_INFO_COMMAND) return { kind: "private", id, error: "presenter_not_authorized" };
	if (!PRESENTER_CLIENT_RECORDS.has(type)) return { kind: "private", id, error: "delegation_unclassified" };
	if (!granted.has("answer")) return { kind: "private", id, error: "delegation_not_granted" };
	return { kind: "presenter", id };
}
