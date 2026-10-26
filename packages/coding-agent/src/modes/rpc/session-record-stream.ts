/**
 * The one projection of a session's events into RPC records: invocation metadata and `agent_end` go through
 * client-message correlation; `queue_update` entries lose their host-minted ids; model and thinking changes
 * carry the selection provenance; an aborted `agent_end` names its abort source and the client that aborted
 * (`abortedBy`), and a deadline-stopped one its `deadline`; `session_abort` names the client that aborted. A
 * host connection and a terminal control endpoint both stream a session through this, so an attached client
 * reads the same records from either.
 */
import type { AgentAbortSource } from "../../core/agent-abort-provenance.ts";
import type { AgentSession, AgentSessionEventListener } from "../../core/agent-session.ts";
import { clientFacingIdentity } from "./client-admission-record.ts";
import { ClientAdmissions } from "./client-admissions.ts";
import { ClientMessageEvents } from "./client-message-events.ts";
import type { RpcCommandInvocationEvent, RpcSkillInvocationEvent } from "./rpc-types.ts";

/** Subscribes `output` to the session's records (from `source`, by default `session.subscribe`); returns the unsubscribe. */
export function subscribeSessionRecords(
	session: AgentSession,
	output: (record: object) => void,
	onAbortSource: (source: AgentAbortSource) => void = () => {},
	source: (listener: AgentSessionEventListener) => () => void = (listener) => session.subscribe(listener),
): () => void {
	const correlatedEvents = new ClientMessageEvents(output, () => ClientAdmissions.forSession(session).hasIdentities);
	return source((event) => {
		if (event.type === "session_lifecycle") {
			// The connection adds the routing handle; classic stdio has no envelope.
			const { sessionId: _sessionId, ...record } = event;
			output(record);
			return;
		}
		if (event.type === "skill_invocation") {
			correlatedEvents.accept(event satisfies RpcSkillInvocationEvent);
			return;
		}
		if (event.type === "command_invocation") {
			correlatedEvents.accept(event satisfies RpcCommandInvocationEvent);
			return;
		}
		if (event.type === "queue_update") {
			// Same route as every other event; only the minted ids are taken out of the projection.
			correlatedEvents.accept({ ...event, ordered: event.ordered.map(clientFacingIdentity) });
			return;
		}
		if (event.type === "thinking_level_changed" || event.type === "model_changed") {
			// Core emits the effective level only; the selection provenance lives beside it
			// on the session and is what distinguishes an explicit choice from a default.
			const thinkingSelection = session.thinkingSelection;
			output(thinkingSelection === undefined ? event : { ...event, thinkingSelection });
			return;
		}
		if (event.type === "agent_end") {
			// The subscribe-path `agent_end` carries only { type, messages, willRetry };
			// the abort provenance the extension hook receives is stripped from it. Read
			// it from the session, which still reports the owner at this point, and retain
			// it for `get_state` because the getter clears once the turn settles.
			const abortSource = session.currentAbortSource;
			if (abortSource !== undefined) onAbortSource(abortSource);
			const deadline = session.currentDeadline;
			const abortedBy = abortSource === undefined ? undefined : ClientAdmissions.forSession(session).abortedBy;
			correlatedEvents.accept({
				...event,
				...(abortSource === undefined ? {} : { aborted: true, abortSource }),
				...(abortedBy === undefined ? {} : { abortedBy }),
				...(deadline === undefined ? {} : { deadline }),
			});
			return;
		}
		if (event.type === "session_abort") {
			const abortedBy = ClientAdmissions.forSession(session).abortedBy;
			correlatedEvents.accept(abortedBy === undefined ? event : { ...event, abortedBy });
			return;
		}
		correlatedEvents.accept(event);
	});
}
