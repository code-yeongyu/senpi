import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { getAgentDir, VERSION } from "../../src/config.ts";
import { engineBuildIdentityFrom } from "../../src/core/engine-build-identity.ts";
import { SessionCommandRouter } from "../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";

// The exact capability list a multi-session host advertises: the wire contract clients negotiate against.

function routerFor() {
	const registry = { list: () => [] } as never;
	return new SessionCommandRouter(registry, new SessionEventWriter(() => {}), { cwd: "/tmp" });
}

describe("multi-session RPC protocol info", () => {
	test("advertises multi-session capability before any session is opened", async () => {
		expect(await routerFor().handle({ id: "probe", type: "get_protocol_info" })).toEqual({
			id: "probe",
			type: "response",
			command: "get_protocol_info",
			success: true,
			data: {
				protocolVersion: 1,
				serverVersion: VERSION,
				capabilities: [
					"multi_session",
					"snapshot_cursor",
					"ui_answer_ledger",
					"dialog_observer",
					"session_lifecycle",
					"expected_host_instance",
					"attach_session",
					"release_attachment",
					"release_caller_aware",
					"reclaim_session",
					"auto_title_sessions",
					"media_placeholders",
					"durable_client_message_id",
					"effect_ledger",
					"subscription_limits",
					"resolve_path",
					"steer_when_idle",
					"continue_from_leaf",
					"eval_cells",
					"auth_key_verify",
					"queued_message_revision",
					"tool_barrier",
					"user_activity",
					"session_held",
					"resume_session",
					"attended",
					"observe_reads",
					"entries_tail",
					"retain_on_disconnect",
					"detach_connection",
					"unload_session",
					"move_session",
					"move_session_revoke",
					"session_relocation",
					"session_context",
					"session_kind",
					"session_status",
					"auto_title_per_session",
					"durable_session_id",
					"moved_path_guard",
					"prompt_surface",
					"prompt_surface_chat",
					"browser_engine",
					"retry_fallback_profile",
					"permission_preset_accept_edits",
					"permission_preset_auto",
					"tool_runtime:in-process",
					"offload_api",
				],
				mode: "multi",
				// Host identity (`protocol-identity.ts`): the instance is this process, the
				// engine ordinal is built from this tree's VERSION by an independent builder,
				// and the launch profile of a router built here is whatever argv the test
				// runner has - `test/rpc-protocol-identity.test.ts` pins its contents against
				// a host launched with known flags.
				instanceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
				generation: 0,
				engineVersion: VERSION,
				engineOrdinal: engineBuildIdentityFrom({ version: VERSION }).ordinal,
				launch_profile: { profile_id: expect.stringMatching(/^[0-9a-f]{64}$/), core: expect.anything() },
				agentDir: resolve(getAgentDir()),
				memory_pressure: false,
				path_identity_resolver: {
					state: expect.stringMatching(/^(not_started|ready|unavailable)$/),
					detail: expect.toSatisfy((value: unknown) => value === null || typeof value === "string"),
				},
			},
		});
	});
});
