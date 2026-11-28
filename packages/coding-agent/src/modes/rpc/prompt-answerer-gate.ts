/**
 * The router's side of senpi#7572 (`prompt-answerer.ts`): who becomes a run's answerer when it opens or attaches, what
 * the replies say about it, and the check every answer passes before it is dispatched to an in-process session or a
 * worker isolate.
 */
import type { OpenRpcSession } from "./session-registry.ts";
import {
	type AnswererUnavailable,
	DESIGNATED_ANSWERER_BY_DEFAULT,
	RPC_ERROR_PROMPT_ANSWERER_REQUIRED,
} from "./prompt-answerer.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import type { RouterContext } from "./session-router-context.ts";
import { error } from "./session-router-errors.ts";

function attached(host: RouterContext, connection: string | undefined, sessionId: string): boolean {
	return connection === undefined || host.sessionsByConnection.get(connection)?.has(sessionId) === true;
}

/**
 * A new run's opener becomes its answerer, under the default rule; called where the opener's connection attaches to a
 * run it created, on every open path (a compact admission included), so no path leaves a run without the rule.
 */
export function designateOpener(
	host: RouterContext,
	opened: OpenRpcSession,
	owner: string | undefined,
	designated = DESIGNATED_ANSWERER_BY_DEFAULT,
): void {
	if (opened.attached) return;
	host.answerers.open(opened.sessionId, owner, designated);
}

type AnswererFields = {
	readonly answerer: boolean;
	readonly answerKey?: string;
	readonly answererUnavailable?: AnswererUnavailable;
};

function answererFields(host: RouterContext, sessionId: string, answerer: boolean): AnswererFields {
	const unavailable = host.answerers.unavailable(sessionId);
	return unavailable === undefined ? { answerer } : { answerer, answererUnavailable: unavailable };
}

/**
 * The answerer fields of an open or claim reply. A reopen the host makes on its own (no reply) of a run that asked for
 * the rule leaves it with no answerer, detectably (`answererUnavailable`); one that did not ask stays without the rule.
 * A run whose opener has no connection identity (stdio) is designated here, where that open replies.
 */
export function openReplyAnswerer(
	host: RouterContext,
	opened: OpenRpcSession,
	reply: boolean,
	designated: boolean | undefined,
): AnswererFields {
	const owner = host.writer.currentConnection();
	if (!reply) {
		if (designated === true) host.answerers.openAfterHandover(opened.sessionId);
		else host.answerers.forgetSession(opened.sessionId);
		syncAnswererPresence(host, opened.sessionId);
		return answererFields(host, opened.sessionId, designated !== true);
	}
	if (!opened.attached) {
		const wanted = designated ?? DESIGNATED_ANSWERER_BY_DEFAULT;
		if (!wanted || !host.answerers.hasMinted(opened.sessionId)) designateOpener(host, opened, owner, wanted);
	}
	const answerKey = host.answerers.takeMinted(opened.sessionId);
	const answerer = host.answerers.isAnswerer(opened.sessionId, owner, attached(host, owner, opened.sessionId));
	syncAnswererPresence(host, opened.sessionId);
	return { ...answererFields(host, opened.sessionId, answerer), ...(answerKey === undefined ? {} : { answerKey }) };
}

/** `attach_session`: a caller presenting the run's key becomes its answerer; the reply says whether it is one. */
export function attachAnswerer(host: RouterContext, owner: string, sessionId: string, key: unknown): AnswererFields {
	const answerer = host.answerers.present(sessionId, owner, key, attached(host, owner, sessionId));
	syncAnswererPresence(host, sessionId);
	return answererFields(host, sessionId, answerer);
}

/**
 * Refuses an answer to a run's dialog or question from anyone but its answerer, before dispatch, so the session (or its
 * worker) never sees it and the prompt stays pending. A secret input keeps its own raiser route, so it is not checked
 * here. Answers reach the router as records `RpcCommand` does not list, so their fields are read, not narrowed.
 */
export function answererGate(host: RouterContext, command: RpcCommand): RpcResponse | undefined {
	const type: unknown = Reflect.get(command, "type");
	if (type !== "extension_ui_response" && type !== "extension_ui_progress") return undefined;
	if (type === "extension_ui_response" && Reflect.get(command, "secret") === true) return undefined;
	const sessionId: unknown = Reflect.get(command, "sessionId");
	if (typeof sessionId !== "string") return undefined;
	const connection = host.writer.currentConnection();
	const key: unknown = Reflect.get(command, "answerKey");
	if (host.answerers.admits(sessionId, connection, attached(host, connection, sessionId), key)) return undefined;
	const id: unknown = Reflect.get(command, "id");
	const handover = host.answerers.unavailable(sessionId) === "host_handover";
	return error(typeof id === "string" ? id : undefined, type, RPC_ERROR_PROMPT_ANSWERER_REQUIRED, {
		reason: handover ? "host_handover" : "not_answerer",
		detail: handover
			? "the host reopened this run after a handover, so no client holds its key"
			: "only this run's designated answerer answers its prompts",
		action: handover
			? "close_session and open_session again to take a new answerKey"
			: "answer from the client that opened the run, or attach_session with its answerKey",
	});
}

/**
 * An answer's key has been checked: nothing after the gate (a session, a worker, a log) receives it. `attach_session`
 * keeps its key, which the router itself reads and never forwards.
 */
export function withoutAnswerKey<C extends RpcCommand>(command: C): C {
	const type: unknown = Reflect.get(command, "type");
	if (type !== "extension_ui_response" && type !== "extension_ui_progress") return command;
	if (!("answerKey" in command)) return command;
	const copy = { ...command };
	Reflect.deleteProperty(copy, "answerKey");
	return copy;
}

/** The socket is gone: it answers no run any more. */
export function forgetAnswererConnection(host: RouterContext, connection: string): void {
	host.answerers.forgetConnection(connection);
}

/**
 * Tells a run that asked for the rule whether one of its answerers is attached now, so its session refuses new asks
 * while none is and settles raised prompts after a grace (`answerer-presence.ts`). A run without the rule hears nothing.
 */
export function syncAnswererPresence(host: RouterContext, sessionId: string): void {
	if (!host.answerers.tracks(sessionId)) return;
	const attachedConnections = [...host.sessionsByConnection]
		.filter(([, owned]) => owned.has(sessionId))
		.map(([connection]) => connection);
	host.bindings.get(sessionId)?.setAnswererPresence?.(host.answerers.answererAttached(sessionId, attachedConnections));
}
