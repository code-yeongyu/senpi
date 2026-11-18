/** The schemas of the host-level inbound records and of the answers a client sends back (senpi#4324). */

import Type, { type TProperties } from "typebox";
import {
	Bool,
	command,
	Id,
	literals,
	Opt,
	OptBool,
	OptId,
	OptNum,
	OptPath,
	OptStr,
	PathStr,
	QuestionAnswers,
	RetryFallback,
	RPC_INBOUND_LIMITS,
	SessionContext,
	SessionEnv,
	SessionKind,
	Str,
	Strings,
	ThinkingLevel,
} from "./method-classes-schema-fields.ts";
import { MOVE_INLINE_MAX_BYTES, MOVE_INLINE_MAX_FILES } from "./session-move-wire.ts";

const move = <const P extends TProperties>(properties: P) => command("move_session", properties);

/** A repository identity as `move_session` op `identity` answers it and op `prepare` takes it back (senpi#6435). */
const RepositoryIdentity = Type.Object({ rootCommits: Strings, originUrl: OptPath });

const uiResponseFrame = {
	secret: OptBool,
	type: Type.Literal("extension_ui_response"),
	id: Id,
	uiRequestId: OptId,
	answerId: OptId,
};

const openProperties = {
	retry: Opt(Type.Literal(true)),
	attended: Opt(Type.Literal(false)),
	spawnedBy: Opt(Type.Object({ parentSessionId: Id, rootSessionId: Id, taskId: Id })),
	expectedHostInstance: OptId,
	sessionPath: OptPath,
	cwd: OptPath,
	provider: OptId,
	modelId: OptId,
	thinkingLevel: Opt(ThinkingLevel),
	permissionPreset: OptId,
	retain_on_disconnect: OptBool,
	kind: Opt(SessionKind),
	context: Opt(SessionContext),
	auto_title: OptBool,
	durableSessionId: OptId,
	promptSurface: Opt(literals("terminal", "app", "chat")),
	browserEngine: Opt(literals("connected", "builtin", "none")),
	retryFallback: Opt(RetryFallback),
	env: Opt(SessionEnv),
};

/** One file of a move's inline bundle (senpi#6267); its bytes are bounded by the cap on the whole bundle. */
const MoveInlineFile = Type.Object({
	path: PathStr,
	sha256: Id,
	base64: Type.String({ maxLength: Math.ceil(MOVE_INLINE_MAX_BYTES / 3) * 4 }),
});
/** The open an import asks for takes `open_session`'s fields, except the session file the import itself names. */
const { sessionPath: _sessionPath, cwd: _cwd, ...moveImportOpenProperties } = openProperties;

export const HOST_RECORD_SCHEMAS = {
	get_protocol_info: command("get_protocol_info", {
		auth: Opt(Type.Object({ client_nonce: Id })),
		observe: OptBool,
	}),
	open_session: command("open_session", openProperties),
	claim_session: command("claim_session", { ...openProperties, cwd: PathStr }),
	park_session: command("park_session", { cwd: PathStr, kind: Opt(SessionKind), context: Opt(SessionContext) }),
	close_session: command("close_session", { sessionId: Id }),
	move_session: Type.Union([
		move({ op: Type.Literal("prepare"), moveId: Id, cwd: OptPath, repository: Opt(RepositoryIdentity) }),
		move({ op: Type.Literal("cancel"), moveId: Id }),
		move({ op: Type.Literal("identity"), sessionPath: PathStr }),
		move({ op: Type.Literal("identity"), cwd: PathStr }),
		move({
			op: Type.Literal("status"),
			moveId: Id,
			sessionPath: OptPath,
			landing: Opt(Type.Object({ cwd: PathStr, sessionFileName: Id, sessionDir: OptPath })),
		}),
		move({
			op: Type.Literal("export"),
			sessionPath: PathStr,
			moveId: Id,
			target: Id,
			droppedUserMessages: Opt(Strings),
			inline: Opt(Type.Literal(true)),
			inlineMaxBytes: OptNum,
		}),
		move({
			op: Type.Literal("import"),
			cwd: PathStr,
			from: OptId,
			bundleDir: OptPath,
			files: Opt(Type.Array(MoveInlineFile, { maxItems: MOVE_INLINE_MAX_FILES })),
			sessionDir: OptPath,
			open: Opt(Type.Union([Type.Literal(true), Type.Object(moveImportOpenProperties)])),
		}),
		move({ op: Type.Literal("finish"), sessionPath: PathStr, moveId: Id, answer: Type.Unknown() }),
		move({ op: Type.Literal("revoke"), sessionPath: PathStr, moveId: Id }),
		move({ op: Type.Literal("copy"), sessionPath: PathStr, sessionId: Id, sessionDir: OptPath }),
	]),
	release_session: command("release_session", {
		sessionId: Id,
		reason: literals("takeover", "move"),
		moveId: OptId,
		target: OptId,
		interrupt: OptBool,
		force: OptBool,
	}),
	unload_session: command("unload_session", {
		sessionId: Id,
		effectId: OptId,
		interrupt: OptBool,
		clearQueue: OptBool,
		children: Opt(literals("refuse", "detach")),
		force: OptBool,
	}),
	detach_connection: command("detach_connection", {}),
	get_subscription_limits: command("get_subscription_limits", { observe: OptBool }),
	list_sessions: command("list_sessions", { include_workers: OptBool, observe: OptBool }),
	subscribe_sessions: command("subscribe_sessions", {
		retry: Opt(Type.Literal(true)),
		sessions: Opt(Type.Union([Type.Literal("all"), Type.Object({ ids: Strings }), Type.Object({ childrenOf: Id })])),
		include_workers: OptBool,
		include_context: OptBool,
		effects: OptBool,
		dialogs: OptBool,
		mirror: Opt(Type.Union([Type.Literal("none"), Type.Literal("all"), Strings])),
		observe: OptBool,
	}),
	unsubscribe_sessions: command("unsubscribe_sessions", { subscriptionId: Id, observe: OptBool }),
	set_session_context: command("set_session_context", {
		sessionId: Id,
		patch: Type.Record(Id, Type.Union([Str, Type.Number(), Bool, Type.Null()]), {
			maxProperties: RPC_INBOUND_LIMITS.recordKeys,
		}),
	}),
	warm: command("warm", { cwd: OptPath, kind: Opt(SessionKind), context: Opt(SessionContext) }),
	attach_session: command("attach_session", {
		sessionId: Id,
		durableSessionId: Id,
		expectedHostInstance: OptId,
		retry: Opt(Type.Literal(true)),
		takeover: Opt(Type.Literal(true)),
		holder: OptId,
	}),
	release_attachment: command("release_attachment", { sessionId: Id }),
	list_hands: command("list_hands", { sessionId: OptId }),
	select_hand: command("select_hand", { sessionId: Id, device: Type.Union([Id, Type.Null()]) }),
	reclaim_session: command("reclaim_session", {
		sessionPath: PathStr,
		durableSessionId: Id,
		expectedHostInstance: Id,
	}),
	extension_ui_response: Type.Union([
		Type.Object({ ...uiResponseFrame, value: Str }),
		Type.Object({ ...uiResponseFrame, confirmed: Bool }),
		Type.Object({ ...uiResponseFrame, cancelled: Type.Literal(true) }),
		Type.Object({ ...uiResponseFrame, answers: QuestionAnswers, comment: OptStr }),
	]),
	extension_ui_progress: Type.Object({
		type: Type.Literal("extension_ui_progress"),
		id: Id,
		answers: Opt(QuestionAnswers),
		comment: OptStr,
		sessionId: OptId,
	}),
	host_response: Type.Object({
		type: Type.Literal("host_response"),
		id: Id,
		sessionId: OptId,
		data: Opt(Type.Unknown()),
		error: OptStr,
	}),
};
