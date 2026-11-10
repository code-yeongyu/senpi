/**
 * One sample record per inbound RPC method, and the generator of the shared fixture
 * `docs/engine-socket/fixtures/rpc-inbound-samples.json` built from them (senpi#5654).
 *
 * A parity test outside the engine (a forwarder, a remote client) enumerates the engine's methods from this file
 * instead of keeping its own list. `RPC_INBOUND_SAMPLES` is typed over `RpcInboundRecord["type"]`, so a method added
 * to the engine fails the typecheck until it has a sample here; `test/rpc/rpc-inbound-samples.test.ts` checks that
 * every sample passes `validateRpcInboundRecord` and that the committed fixture is byte-identical to
 * `buildRpcInboundSampleFixture()`. Regenerate with `node packages/coding-agent/scripts/rpc-inbound-samples.ts --write`.
 *
 * Samples are meant to be sent to a test engine: every id is `SAMPLE_ID`, every host path is under
 * `SAMPLE_PATH_ROOT` (which does not exist, so reads miss and writes fail), provider and model names are unknown to
 * the engine (login and account methods are refused instead of starting a sign-in), and no record carries a
 * credential.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	classifyRpcMethod,
	describeRpcMethodClasses,
	type RpcInboundRecordOf,
	type RpcMethodClass,
	type RpcMethodClassDescription,
	type RpcMethodType,
} from "../src/modes/rpc/method-classes.ts";

export const RPC_INBOUND_SAMPLE_FIXTURE = "docs/engine-socket/fixtures/rpc-inbound-samples.json";

/** The id every sample uses wherever a record names a session, entry, effect, queue item, cell or admission. */
const SAMPLE_ID = "00000000-0000-7000-8000-000000000000";
/** Every host path a sample names lies under this directory, which does not exist. */
export const SAMPLE_PATH_ROOT = "/nonexistent/senpi-rpc-inbound-sample";
const PROVIDER = "rpc-sample-provider";
const MODEL = "rpc-sample-model";
const ACCOUNT = "rpc-sample-account";

type RpcInboundSampleTable = { readonly [K in RpcMethodType]: RpcInboundRecordOf<K> };

export const RPC_INBOUND_SAMPLES = {
	get_protocol_info: { type: "get_protocol_info" },
	open_session: { type: "open_session" },
	park_session: { type: "park_session", cwd: `${SAMPLE_PATH_ROOT}/cwd` },
	claim_session: { type: "claim_session", cwd: `${SAMPLE_PATH_ROOT}/cwd` },
	close_session: { type: "close_session", sessionId: SAMPLE_ID },
	move_session: { type: "move_session", op: "status", moveId: SAMPLE_ID },
	release_session: { type: "release_session", sessionId: SAMPLE_ID, reason: "takeover" },
	unload_session: { type: "unload_session", sessionId: SAMPLE_ID },
	detach_connection: { type: "detach_connection" },
	get_subscription_limits: { type: "get_subscription_limits" },
	list_sessions: { type: "list_sessions" },
	list_hands: { type: "list_hands" },
	select_hand: { type: "select_hand", sessionId: SAMPLE_ID, device: null },
	subscribe_sessions: { type: "subscribe_sessions", sessions: { ids: [SAMPLE_ID] } },
	unsubscribe_sessions: { type: "unsubscribe_sessions", subscriptionId: SAMPLE_ID },
	set_session_context: { type: "set_session_context", sessionId: SAMPLE_ID, patch: { sample: "rpc-inbound" } },
	warm: { type: "warm" },
	attach_session: { type: "attach_session", sessionId: SAMPLE_ID, durableSessionId: SAMPLE_ID },
	release_attachment: { type: "release_attachment", sessionId: SAMPLE_ID },
	reclaim_session: {
		type: "reclaim_session",
		sessionPath: `${SAMPLE_PATH_ROOT}/reclaim.jsonl`,
		durableSessionId: SAMPLE_ID,
		expectedHostInstance: SAMPLE_ID,
	},
	extension_ui_response: { type: "extension_ui_response", id: SAMPLE_ID, cancelled: true },
	extension_ui_progress: { type: "extension_ui_progress", id: SAMPLE_ID },
	host_response: { type: "host_response", id: SAMPLE_ID, error: "rpc inbound sample" },
	prompt: { type: "prompt", message: "Sample prompt." },
	release_tool_barrier: { type: "release_tool_barrier", barrierId: SAMPLE_ID },
	send_custom_message: {
		type: "send_custom_message",
		customType: "rpc-inbound-sample",
		content: "Sample custom message.",
		display: false,
	},
	continue_from_leaf: { type: "continue_from_leaf" },
	resume_session: { type: "resume_session" },
	append_user_message: { type: "append_user_message", content: "Sample appended message." },
	append_session_entry: {
		type: "append_session_entry",
		entry: {
			type: "message",
			id: SAMPLE_ID,
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: { role: "user", content: "Sample appended entry.", timestamp: 0 },
		},
	},
	steer: { type: "steer", message: "Sample steer." },
	follow_up: { type: "follow_up", message: "Sample follow-up." },
	abort: { type: "abort" },
	interrupt: { type: "interrupt" },
	hold_input: { type: "hold_input", inputId: SAMPLE_ID, revision: 1, text: "Sample held input." },
	withdraw_held_input: { type: "withdraw_held_input", inputId: SAMPLE_ID },
	pause_for_run: {
		type: "pause_for_run",
		parentSessionId: SAMPLE_ID,
		parentPauseSeq: 1,
		runRef: { kind: "task", id: SAMPLE_ID },
	},
	resume_for_run: {
		type: "resume_for_run",
		parentSessionId: SAMPLE_ID,
		parentPauseSeq: 1,
		resumeId: SAMPLE_ID,
		childSeqCutoff: 0,
	},
	abort_compaction: { type: "abort_compaction" },
	reload: { type: "reload" },
	check_reload_veto: { type: "check_reload_veto" },
	clear_queue: { type: "clear_queue" },
	dequeue_message: { type: "dequeue_message", queuedId: SAMPLE_ID },
	edit_queued_message: { type: "edit_queued_message", queuedId: SAMPLE_ID, text: "Sample edit." },
	get_steering_messages: { type: "get_steering_messages" },
	get_follow_up_messages: { type: "get_follow_up_messages" },
	abort_branch_summary: { type: "abort_branch_summary" },
	new_session: { type: "new_session" },
	wake: { type: "wake" },
	admit_external_message: {
		type: "admit_external_message",
		deliveryId: SAMPLE_ID,
		text: "Sample delivery.",
		sender: { kind: "agent", session_id: SAMPLE_ID },
		deliverAs: "followUp",
		whenIdle: "queue",
	},
	get_state: { type: "get_state" },
	get_snapshot: { type: "get_snapshot", tail: 0 },
	request_self_settle: { type: "request_self_settle" },
	get_effect_status: { type: "get_effect_status", effectId: SAMPLE_ID },
	get_pending_inputs: { type: "get_pending_inputs" },
	set_model: { type: "set_model", provider: PROVIDER, modelId: MODEL },
	set_favorite_models: { type: "set_favorite_models", models: [] },
	set_scoped_models: { type: "set_scoped_models", models: [] },
	cycle_model: { type: "cycle_model" },
	get_available_models: { type: "get_available_models" },
	set_thinking_level: { type: "set_thinking_level", level: "off", scope: "turn" },
	cycle_thinking_level: { type: "cycle_thinking_level" },
	get_available_thinking_levels: { type: "get_available_thinking_levels" },
	get_model_thinking_level: { type: "get_model_thinking_level", provider: PROVIDER, modelId: MODEL },
	set_fast_mode: { type: "set_fast_mode", enabled: false },
	get_fast_mode: { type: "get_fast_mode" },
	set_steering_mode: { type: "set_steering_mode", mode: "all" },
	set_follow_up_mode: { type: "set_follow_up_mode", mode: "all" },
	compact: { type: "compact" },
	set_auto_compaction: { type: "set_auto_compaction", enabled: false },
	set_permission_preset: { type: "set_permission_preset", permissionPreset: "ask" },
	set_auto_retry: { type: "set_auto_retry", enabled: false },
	abort_retry: { type: "abort_retry" },
	set_retry_fallback: {
		type: "set_retry_fallback",
		retryFallback: { modelFallback: false, fallbackChains: { main: [`${PROVIDER}/${MODEL}`] } },
	},
	bash: { type: "bash", command: "true" },
	record_bash_result: {
		type: "record_bash_result",
		command: "true",
		result: { output: "", exitCode: 0, cancelled: false, truncated: false },
	},
	abort_bash: { type: "abort_bash" },
	cleanup_bash_output: { type: "cleanup_bash_output", path: `${SAMPLE_PATH_ROOT}/bash-output.txt` },
	set_label: { type: "set_label", entryId: SAMPLE_ID, label: "sample" },
	navigate_tree: { type: "navigate_tree", entryId: SAMPLE_ID },
	get_session_stats: { type: "get_session_stats" },
	resolve_path: { type: "resolve_path", path: `${SAMPLE_PATH_ROOT}/resolve` },
	memory_report: { type: "memory_report" },
	export_html: { type: "export_html", outputPath: `${SAMPLE_PATH_ROOT}/export.html` },
	export_jsonl: { type: "export_jsonl", outputPath: `${SAMPLE_PATH_ROOT}/export.jsonl` },
	switch_session: { type: "switch_session", sessionPath: `${SAMPLE_PATH_ROOT}/switch.jsonl` },
	fork: { type: "fork", entryId: SAMPLE_ID },
	edit_assistant_message: { type: "edit_assistant_message", entryId: SAMPLE_ID, text: "Sample edit." },
	edit_user_message: { type: "edit_user_message", entryId: SAMPLE_ID, text: "Sample edit." },
	clone: { type: "clone" },
	get_fork_messages: { type: "get_fork_messages" },
	get_entries: { type: "get_entries", limit: 1 },
	get_tree: { type: "get_tree" },
	get_last_assistant_text: { type: "get_last_assistant_text" },
	set_session_name: { type: "set_session_name", name: "rpc inbound sample" },
	record_user_activity: { type: "record_user_activity", kind: "draft" },
	import_jsonl: { type: "import_jsonl", inputPath: `${SAMPLE_PATH_ROOT}/import.jsonl` },
	get_messages: { type: "get_messages" },
	get_media: { type: "get_media", toolCallId: SAMPLE_ID, contentIndex: 0 },
	get_commands: { type: "get_commands" },
	get_loaded_surfaces: { type: "get_loaded_surfaces" },
	get_project_trust: { type: "get_project_trust" },
	set_project_trust: { type: "set_project_trust", choice: "trust" },
	get_project_settings: { type: "get_project_settings" },
	set_project_setting: { type: "set_project_setting", key: "defaultThinkingLevel", value: "minimal" },
	extension_request: { type: "extension_request", name: "rpc-inbound-sample" },
	"eval_cells.list": { type: "eval_cells.list" },
	"eval_cells.peek": { type: "eval_cells.peek", cellId: SAMPLE_ID },
	"eval_cells.stop": { type: "eval_cells.stop", cellId: SAMPLE_ID },
	get_auth_providers: { type: "get_auth_providers" },
	login_start: { type: "login_start", provider: PROVIDER },
	login_cancel: { type: "login_cancel", provider: PROVIDER },
	login_api_key: { type: "login_api_key", provider: PROVIDER, key: "rpc-sample-not-a-key" },
	logout: { type: "logout", provider: PROVIDER },
	verify_api_key: { type: "verify_api_key", provider: PROVIDER, key: "rpc-sample-not-a-key" },
	get_provider_accounts: { type: "get_provider_accounts", provider: PROVIDER },
	account_pin: { type: "account_pin", provider: PROVIDER, name: null },
	account_remove: { type: "account_remove", provider: PROVIDER, name: ACCOUNT },
	account_reset: { type: "account_reset", provider: PROVIDER, name: ACCOUNT },
	account_order: { type: "account_order", provider: PROVIDER, names: null },
	test_provider_account: { type: "test_provider_account", provider: PROVIDER, name: ACCOUNT },
	set_client_info: { type: "set_client_info", width: 80 },
	get_recovery_page: {
		type: "get_recovery_page",
		token: SAMPLE_ID,
		admissionId: SAMPLE_ID,
		componentRef: SAMPLE_ID,
		requestId: SAMPLE_ID,
	},
	release_recovery: { type: "release_recovery", lease: { kind: "event", id: SAMPLE_ID }, admissionId: SAMPLE_ID },
	cancel_attempt: { type: "cancel_attempt", admissionId: SAMPLE_ID },
	reset_stream: { type: "reset_stream", admissionId: SAMPLE_ID },
} as const satisfies RpcInboundSampleTable;

/** One fixture row: a method, how the engine's table classes it, and a record of it. */
export interface RpcInboundSampleEntry {
	readonly method: RpcMethodType;
	/** The table entry: a class, or `dynamic` when the class depends on the record. */
	readonly class: RpcMethodClassDescription;
	/** The rule version of a `dynamic` entry (absent otherwise). */
	readonly dynamicVersion?: number;
	/** The class the engine assigns to `sample`. */
	readonly sampleClass: RpcMethodClass;
	/** `sampleClass` is `connection_local`: a forwarder refuses the record instead of sending it on. */
	readonly connectionLocal: boolean;
	readonly sample: RpcInboundRecordOf<RpcMethodType>;
}

export interface RpcInboundSampleFixture {
	readonly methodClassesVersion: number;
	readonly methodClassesDigest: string;
	readonly sampleId: string;
	readonly samplePathRoot: string;
	readonly methodCount: number;
	readonly methods: readonly RpcInboundSampleEntry[];
}

/** The fixture's rows, sorted by method name. */
export function buildRpcInboundSampleFixture(): RpcInboundSampleFixture {
	const table = describeRpcMethodClasses();
	const samples: Readonly<Record<RpcMethodType, RpcInboundRecordOf<RpcMethodType>>> = RPC_INBOUND_SAMPLES;
	const methods = (Object.keys(table.classes) as RpcMethodType[]).sort().map((method): RpcInboundSampleEntry => {
		const sample = samples[method];
		const sampleClass = classifyRpcMethod(sample);
		if (sampleClass === undefined) throw new Error(`the engine cannot classify the ${method} sample`);
		const dynamicVersion = table.dynamic_versions[method];
		return {
			method,
			class: table.classes[method],
			...(dynamicVersion === undefined ? {} : { dynamicVersion }),
			sampleClass,
			connectionLocal: sampleClass === "connection_local",
			sample,
		};
	});
	return {
		methodClassesVersion: table.version,
		methodClassesDigest: table.digest,
		sampleId: SAMPLE_ID,
		samplePathRoot: SAMPLE_PATH_ROOT,
		methodCount: methods.length,
		methods,
	};
}

export const serializeRpcInboundSampleFixture = (fixture: RpcInboundSampleFixture): string =>
	`${JSON.stringify(fixture, null, "\t")}\n`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--write")) {
	const target = join(dirname(fileURLToPath(import.meta.url)), "..", RPC_INBOUND_SAMPLE_FIXTURE);
	writeFileSync(target, serializeRpcInboundSampleFixture(buildRpcInboundSampleFixture()));
}
