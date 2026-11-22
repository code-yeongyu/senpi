/**
 * The TUI control endpoint's deliberate method-class exclusions (senpi#6160): commands its `get_protocol_info`
 * advertises that the shared `RPC_METHOD_CLASS` table does not classify, each with its recorded reason. The table is
 * the engine's classification of rpc-host record types only (senpi#4319), so a terminal-only command cannot enter it
 * without widening the host's record union, and senpi#4249 R-1b already keeps the presenter client records outside it
 * on purpose (a forwarder that pins the table's digest keeps working). A remote relay refuses every command named
 * here as `method_unclassified` — by decision, not by omission.
 *
 * `test/rpc/tui-method-class-coverage.test.ts` fails the moment a command the endpoint advertises is neither
 * classified in the table nor listed here, and the moment a listed command stops being advertised, gains a table
 * entry, or loses its reason.
 */
export const TUI_METHOD_CLASS_EXCLUSIONS: Readonly<Record<string, string>> = {
	// The terminal's own feed subscription: per-connection state, the same rule as the host's
	// subscribe_sessions/unsubscribe_sessions (connection_local) - a forwarder serves the stream itself, so it is
	// never sent on someone else's behalf; the shared table classifies host record types only.
	subscribe: "per-connection feed state, never forwarded on someone else's behalf (the subscribe_sessions rule)",
	// Presenter client records (senpi#4249 R-1b): the delegated-connection gate decides these under the answer
	// grant (delegated-presenter-records.ts), deliberately outside RPC_METHOD_CLASS so the digest a forwarder
	// pins keeps working.
	mcp_presenter_context: "presenter client record: decided by the delegated gate's answer grant, not the shared table",
	mcp_form_presented: "presenter client record: decided by the delegated gate's answer grant, not the shared table",
	mcp_form_response: "presenter client record: decided by the delegated gate's answer grant, not the shared table",
	mcp_form_sync: "presenter client record: decided by the delegated gate's answer grant, not the shared table",
	// A sealed secret answer: only a local presenter connection the secret was presented to may answer it; a
	// relay forwarder never declares secret_input_v1 for another device's secret (docs/rpc.md, Private secret
	// input), so remote use stays unclassified and refused.
	mcp_presenter_secret_answer:
		"sealed secret answer: local presenter only, never relayed (docs/rpc.md, Private secret input)",
};
