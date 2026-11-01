/**
 * The engine's own classification of every inbound RPC record (senpi#4319).
 *
 * A client that speaks for someone other than the local user (a forwarder, a remote viewer, an automation) needs
 * to know which records it may accept from that someone. A list kept outside the engine drifts the moment a method
 * lands, so the table lives here and is exhaustive at compile time: it `satisfies` a mapped type over
 * `RpcInboundRecord["type"]`, so a record type added without a class fails the typecheck. An entry is a class, or a
 * versioned rule (a pure function of the record) when the class depends on its fields. The engine only classifies;
 * it does not gate its own local connections with this table.
 *
 * Classes, least to most dangerous:
 * - `observe`: side-effect-free reads.
 * - `drive`: runs, steers or edits the current session (prompts, queue and user-message edits, session-scoped
 *   settings; a setter that writes the device-wide settings file is `device_admin`). A prompt that can run a slash command is
 *   `device_admin`: extension command handlers run with the same unbounded context as `extension_request`.
 * - `answer`: replies to a question or dialog the engine asked. The engine's permission prompts are such dialogs, so
 *   a caller granted `answer` can approve what `device_admin` would otherwise gate: never treat it as harmless.
 * - `thread`: creates, opens, attaches, forks or closes sessions by id. A record that names a host path (a session
 *   file, a cwd, an import source, a parent session), a permission preset, or the environment of the session's tool
 *   subprocesses is `device_admin`: it reads or writes host files, or changes what the agent may do without asking.
 * - `device_admin`: acts on the device outside the agent's own permission flow (direct shell, filesystem writes and
 *   probes, credentials, device-wide settings, extension reloads, forged session entries: an assistant reply or custom message the engine did not produce, whether
 *   appended, sent or edited in). A remote caller reaches it
 *   only when it is a caller granted the class.
 * - `connection_local`: configures or tears down the caller's own connection or host ownership; meaningful only to
 *   the connection that sends it, so it is never permitted on someone else's behalf.
 *
 * At runtime a record the table does not classify (unknown type, non-string type, not an object) is treated as more
 * dangerous than every class: `rpcMethodPermitted` refuses it whatever is granted.
 */

import { createHash } from "node:crypto";
import type { SessionEntry, SessionMessageEntry } from "../../core/session-manager.ts";
import type { RpcInboundRecord } from "./rpc-host-command-types.ts";

export type RpcMethodClass = "observe" | "drive" | "answer" | "thread" | "device_admin" | "connection_local";

export type RpcMethodType = RpcInboundRecord["type"];

export type RpcInboundRecordOf<K extends RpcMethodType> = Extract<RpcInboundRecord, { type: K }>;

/**
 * A record-dependent entry: a pure function of the record plus the version of its rule. The digest hashes the entry
 * as `type=dynamic@<version>`, so changing what `classify` decides REQUIRES bumping `version`; otherwise a client
 * holding the old digest never learns the rule moved. The outputs of each version are pinned by a fixture keyed
 * `<type>@<version>` in `test/rpc/method-class-table.test.ts`, and the record fields each rule was reviewed against
 * are pinned there too: a classify change without a version bump, or a new field on the record, fails that test.
 */
interface RpcMethodClassRule<K extends RpcMethodType> {
	readonly classify: (record: RpcInboundRecordOf<K>) => RpcMethodClass;
	readonly version: number;
}

/** A fixed class, or a versioned rule for a type whose class depends on its fields. */
type RpcMethodClassEntry<K extends RpcMethodType> = RpcMethodClass | RpcMethodClassRule<K>;

type RpcMethodClassTable = { readonly [K in RpcMethodType]: RpcMethodClassEntry<K> };

/** Bumped when the meaning of a class changes; a reassignment changes only the digest. */
export const RPC_METHOD_CLASSES_VERSION = 1;

/** How the table description names an entry whose class depends on the record. */
const DYNAMIC = "dynamic";

/**
 * Which session entry types a user could author through the session's own input. Exhaustive over
 * `SessionEntry["type"]`, so a new entry type has to be placed here before it typechecks.
 */
const ENTRY_AUTHORSHIP = {
	message: "user_role_only",
	thinking_level_change: "engine",
	configuration_update: "engine",
	model_change: "engine",
	model_change_rejected: "engine",
	usage: "engine",
	compaction: "engine",
	branch_summary: "engine",
	custom: "engine",
	custom_message: "engine",
	context_edit: "engine",
	label: "engine",
	session_info: "engine",
} as const satisfies Record<SessionEntry["type"], "user_role_only" | "engine">;

const USER_ROLE = "user" satisfies SessionMessageEntry["message"]["role"];

/**
 * A user-authored message entry drives the session; any other entry is a forged record of engine work, the same class as
 * `edit_assistant_message` and `send_custom_message`, which write that record by another route.
 */
function appendEntryClass(record: object): RpcMethodClass {
	const entry: unknown = Reflect.get(record, "entry");
	if (typeof entry !== "object" || entry === null) return "device_admin";
	const entryType: unknown = Reflect.get(entry, "type");
	if (typeof entryType !== "string" || !Object.hasOwn(ENTRY_AUTHORSHIP, entryType)) return "device_admin";
	if (ENTRY_AUTHORSHIP[entryType as SessionEntry["type"]] !== "user_role_only") return "device_admin";
	const message: unknown = Reflect.get(entry, "message");
	if (typeof message !== "object" || message === null) return "device_admin";
	return Reflect.get(message, "role") === USER_ROLE ? "drive" : "device_admin";
}

/** A field that names a host path or a permission preset; present means any value but `undefined` (null included). */
function namesAny(record: object, fields: ReadonlyArray<string>): boolean {
	return fields.some((field) => Object.hasOwn(record, field) && Reflect.get(record, field) !== undefined);
}

/**
 * Opening by id is a thread operation; naming a session file, a cwd, a permission preset, a browser engine (the
 * user's own signed-in browser) or an environment for the session's tool subprocesses (`env`, version 2) acts on
 * the device.
 */
function openSessionClass(record: object): RpcMethodClass {
	return namesAny(record, ["sessionPath", "cwd", "permissionPreset", "browserEngine", "env"])
		? "device_admin"
		: "thread";
}

/** `scope: "turn"` changes only this turn; any other scope remembers the model's level device-wide. */
function thinkingLevelClass(record: object): RpcMethodClass {
	return Reflect.get(record, "scope") === "turn" ? "drive" : "device_admin";
}

/** An effect looked up by session id is a read; one looked up in a named session file opens a host path. */
function effectStatusClass(record: object): RpcMethodClass {
	return namesAny(record, ["sessionPath"]) ? "device_admin" : "observe";
}

/**
 * Prompt text is `drive`; text that can dispatch a registered slash command is `device_admin`, because the handler runs
 * with a full command context (`/mcp` writes the MCP config and starts servers, `/account` edits credentials, `/ir`
 * reads any host path). Mirrors the session's own dispatch check: templates expand unless `expandPromptTemplates` is exactly
 * `false`, and the raw message starts with `/`. Whether the command exists is left to the session, so an unregistered
 * name is not a reason to answer lower; a message that is not a string cannot be judged.
 */
function promptClass(record: object): RpcMethodClass {
	const message: unknown = Reflect.get(record, "message");
	if (typeof message !== "string") return "device_admin";
	if (Reflect.get(record, "expandPromptTemplates") === false) return "drive";
	return message.startsWith("/") ? "device_admin" : "drive";
}

/**
 * `steer`/`follow_up` with `whenIdle: "start"` take the prompt path, which expands commands (with no template option);
 * the queue path refuses registered commands. So a turn-starting message that is not a string or starts with `/` is
 * `device_admin`, like `prompt`; anything else is `drive`.
 */
function idleStartClass(record: object): RpcMethodClass {
	if (Reflect.get(record, "whenIdle") !== "start") return "drive";
	const message: unknown = Reflect.get(record, "message");
	return typeof message !== "string" || message.startsWith("/") ? "device_admin" : "drive";
}

/** A new session is a thread operation; naming a parent session file reads a host path. */
function newSessionClass(record: object): RpcMethodClass {
	return namesAny(record, ["parentSession"]) ? "device_admin" : "thread";
}

export const RPC_METHOD_CLASS = {
	// observe
	get_protocol_info: "observe",
	get_subscription_limits: "observe",
	list_sessions: "observe",
	get_state: "observe",
	get_snapshot: "observe",
	get_entries: "observe",
	get_messages: "observe",
	get_tree: "observe",
	get_fork_messages: "observe",
	get_last_assistant_text: "observe",
	get_session_stats: "observe",
	// observe by session id; device_admin when it names a session file (it opens that host path)
	get_effect_status: { classify: effectStatusClass, version: 1 },
	get_pending_inputs: "observe",
	get_follow_up_messages: "observe",
	get_steering_messages: "observe",
	get_commands: "observe",
	get_loaded_surfaces: "observe",
	get_available_models: "observe",
	get_available_thinking_levels: "observe",
	get_model_thinking_level: "observe",
	get_fast_mode: "observe",
	get_media: "observe",
	memory_report: "observe",
	"eval_cells.list": "observe",
	"eval_cells.peek": "observe",
	// drive
	// drive for text; device_admin when the text can run a slash command (rule prompt@1)
	prompt: { classify: promptClass, version: 1 },
	// drive, except a turn-starting slash command (rules steer@1 / follow_up@1)
	steer: { classify: idleStartClass, version: 1 },
	follow_up: { classify: idleStartClass, version: 1 },
	abort: "drive",
	interrupt: "drive",
	abort_retry: "drive",
	abort_compaction: "drive",
	abort_branch_summary: "drive",
	compact: "drive",
	clear_queue: "drive",
	dequeue_message: "drive",
	edit_queued_message: "drive",
	hold_input: "drive",
	withdraw_held_input: "drive",
	append_user_message: "drive",
	edit_user_message: "drive",
	continue_from_leaf: "drive",
	navigate_tree: "drive",
	set_label: "drive",
	set_session_name: "drive",
	// drive only for this turn's level; otherwise it remembers the model's level in the device-wide settings
	set_thinking_level: { classify: thinkingLevelClass, version: 1 },
	// a session override; set_steering_mode, set_follow_up_mode and set_auto_retry write global settings (device_admin)
	set_auto_compaction: "drive",
	set_retry_fallback: "drive",
	pause_for_run: "drive",
	resume_for_run: "drive",
	wake: "drive",
	release_tool_barrier: "drive",
	request_self_settle: "drive",
	"eval_cells.stop": "drive",
	// drive for a user-authored message entry, device_admin for any other entry
	append_session_entry: { classify: appendEntryClass, version: 1 },
	// answer
	extension_ui_response: "answer",
	extension_ui_progress: "answer",
	// thread
	// thread by id; device_admin when the record names a host path, a permission preset or a tool environment
	new_session: { classify: newSessionClass, version: 1 },
	open_session: { classify: openSessionClass, version: 2 },
	resume_session: "thread",
	fork: "thread",
	clone: "thread",
	close_session: "thread",
	unload_session: "thread",
	set_session_context: "thread",
	attach_session: "thread",
	// device_admin
	bash: "device_admin",
	abort_bash: "device_admin",
	record_bash_result: "device_admin",
	cleanup_bash_output: "device_admin",
	extension_request: "device_admin",
	reload: "device_admin",
	check_reload_veto: "device_admin",
	resolve_path: "device_admin",
	login_start: "device_admin",
	login_cancel: "device_admin",
	login_api_key: "device_admin",
	logout: "device_admin",
	verify_api_key: "device_admin",
	get_auth_providers: "device_admin",
	get_provider_accounts: "device_admin",
	account_order: "device_admin",
	account_pin: "device_admin",
	account_remove: "device_admin",
	// clears the stored account's cooldown/block state through the auth storage, like account_remove
	account_reset: "device_admin",
	// runs the sign-in connection test on a stored account and writes its result through the auth storage
	test_provider_account: "device_admin",
	set_favorite_models: "device_admin",
	set_scoped_models: "device_admin",
	// each writes the device-wide settings file, not a session override (set_model and cycle_model persist the default
	// model, set_fast_mode the service tier)
	set_model: "device_admin",
	cycle_model: "device_admin",
	cycle_thinking_level: "device_admin",
	set_fast_mode: "device_admin",
	set_steering_mode: "device_admin",
	set_follow_up_mode: "device_admin",
	set_auto_retry: "device_admin",
	// switch_session opens (and appends to) the named session file; import_jsonl reads any host file into a session
	// both write what the model reads as engine work: an assistant reply it never gave, a custom context message
	// (append_session_entry classes the same entries appended directly as device_admin)
	edit_assistant_message: "device_admin",
	send_custom_message: "device_admin",
	switch_session: "device_admin",
	import_jsonl: "device_admin",
	// both forms write a file on the host: without `outputPath`, into the session's cwd
	export_html: "device_admin",
	export_jsonl: "device_admin",
	// connection_local
	set_client_info: "connection_local",
	// a forwarder serves session streams itself; per-connection subscription state cannot be forwarded
	subscribe_sessions: "connection_local",
	unsubscribe_sessions: "connection_local",
	record_user_activity: "connection_local",
	detach_connection: "connection_local",
	release_session: "connection_local",
	// loads the extension graph for a caller-named cwd (device_admin in effect); safe only because connection_local is
	// never permitted on someone else's behalf
	warm: "connection_local",
	host_response: "connection_local",
	release_attachment: "connection_local",
	reclaim_session: "connection_local",
	move_session: "connection_local",
	// pages a recovery token this connection holds; every answer is scoped to the asking connection's peer incarnation
	get_recovery_page: "connection_local",
} as const satisfies RpcMethodClassTable;

/**
 * The class of an inbound record, or `undefined` when the engine cannot classify it: not a plain object, a
 * non-string `type`, a type the table does not own (own keys only, never the prototype's), or a record whose rule
 * throws (a hostile getter or proxy): a rule that cannot decide refuses.
 */
export function classifyRpcMethod(record: unknown): RpcMethodClass | undefined {
	if (typeof record !== "object" || record === null || Array.isArray(record)) return undefined;
	try {
		const type: unknown = Reflect.get(record, "type");
		if (typeof type !== "string" || !Object.hasOwn(RPC_METHOD_CLASS, type)) return undefined;
		const entry: RpcMethodClass | { readonly classify: (record: object) => RpcMethodClass } =
			RPC_METHOD_CLASS[type as RpcMethodType];
		return typeof entry === "string" ? entry : entry.classify(record);
	} catch {
		return undefined;
	}
}

/**
 * Whether a caller granted `granted` may send `record`. Fails closed: an unclassified record is refused whatever is
 * granted, `connection_local` is never permitted, and every other class only when the caller is granted that class.
 */
export function rpcMethodPermitted(record: unknown, granted: ReadonlySet<RpcMethodClass>): boolean {
	const methodClass = classifyRpcMethod(record);
	return methodClass !== undefined && methodClass !== "connection_local" && granted.has(methodClass);
}

export type RpcMethodClassDescription = RpcMethodClass | typeof DYNAMIC;

/** Every entry as a class, or `dynamic` for a record-dependent entry, and the version of each `dynamic` entry. */
export interface RpcMethodClassesDescription {
	readonly version: typeof RPC_METHOD_CLASSES_VERSION;
	readonly digest: string;
	readonly classes: Readonly<Record<RpcMethodType, RpcMethodClassDescription>>;
	readonly dynamic_versions: Readonly<Partial<Record<RpcMethodType, number>>>;
}

/**
 * sha256 (hex) of the sorted `type=value\n` lines, where `value` is the class, or `dynamic@<version>` for a
 * record-dependent entry.
 */
export function rpcMethodClassesDigest(table: Readonly<Record<string, string>>): string {
	const lines = Object.entries(table)
		.map(([type, methodClass]) => `${type}=${methodClass}\n`)
		.sort();
	return createHash("sha256").update(lines.join("")).digest("hex");
}

/** The digest input of one entry: its class, or `dynamic@<version>` for a record-dependent entry. */
function digestValue(entry: RpcMethodClass | { readonly version: number }): string {
	return typeof entry === "string" ? entry : `${DYNAMIC}@${entry.version}`;
}

export const RPC_METHOD_CLASSES_DIGEST = rpcMethodClassesDigest(
	Object.fromEntries(Object.entries(RPC_METHOD_CLASS).map(([type, entry]) => [type, digestValue(entry)])),
);

/** The whole table as data: what a client compares against its own copy. */
export function describeRpcMethodClasses(): RpcMethodClassesDescription {
	const classes: Record<string, RpcMethodClassDescription> = {};
	const dynamicVersions: Record<string, number> = {};
	for (const [type, entry] of Object.entries(RPC_METHOD_CLASS)) {
		if (typeof entry === "string") {
			classes[type] = entry;
		} else {
			classes[type] = DYNAMIC;
			dynamicVersions[type] = entry.version;
		}
	}
	return {
		version: RPC_METHOD_CLASSES_VERSION,
		digest: RPC_METHOD_CLASSES_DIGEST,
		classes: classes as RpcMethodClassesDescription["classes"],
		dynamic_versions: dynamicVersions,
	};
}
