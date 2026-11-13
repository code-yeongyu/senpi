import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { getAgentDir, VERSION } from "../../src/config.ts";
import { engineBuildIdentityFrom } from "../../src/core/engine-build-identity.ts";
import { describeRpcMethodClasses } from "../../src/modes/rpc/method-classes.ts";
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
					"secret_input_v1", // senpi#5108: hosts advertise guarded private input.
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
					"find_session", // senpi#6429: which session file carries a durable id, read-only.
					"steer_when_idle",
					"continue_from_leaf",
					"eval_cells",
					"auth_key_verify",
					"provider_account_test",
					"account_reset",
					"queued_message_revision",
					"tool_barrier",
					"user_activity",
					"session_model_scope", // senpi#5933: set_model honours scope "session".
					"session_held",
					"resume_session",
					"attended",
					"observe_reads",
					"entries_tail",
					"set_permission_preset_v1",
					"retain_on_disconnect",
					"open_session_header_cwd", // senpi#6427: an open by path with no cwd works where the file's header says.
					"detach_connection",
					"delegated_connection_v1",
					"delegation_roles_v1",
					"peer_agent_role_v1",
					"same_account_delegation_v1",
					"unload_session",
					"unload_session_dry_run",
					"client_identity",
					"move_session",
					"move_session_revoke",
					"move_session_copy",
					"move_session_export_inline", // senpi#6267: a move's bundle travels inside the move answers.
					"move_session_import_files",
					"move_session_import_session_dir",
					"move_session_import_open",
					"move_session_inline_max_bytes:1048576",
					"move_session_identity", // senpi#6435: a session's recorded repository, read without a release.
					"move_session_prepare_repository", // senpi#6435: prepare checks the folder's repository.
					"move_session_prepare_occupied", // senpi#6471: prepare refuses a landing file that is already taken.
					"move_session_status_landed_path", // senpi#6436: where an accepted move landed.
					"move_session_status_writable", // senpi#6473: whether the landed copy can still be written.
					"move_session_status_landing",
					"release_session_expect_id",
					"move_session_ownership",
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
					"session_env",
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
				// The method-class table this engine runs; `test/rpc/method-class-table.test.ts` pins how the digest is built.
				method_classes: describeRpcMethodClasses(),
				path_identity_resolver: {
					state: expect.stringMatching(/^(not_started|ready|unavailable)$/),
					detail: expect.toSatisfy((value: unknown) => value === null || typeof value === "string"),
				},
			},
		});
	});
});
