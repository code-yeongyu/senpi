/**
 * A bound control endpoint's live wiring and its clean exit.
 *
 * Edges: `agent_idle` -> idle; a delivery's entry written -> emitted; SIGCONT -> continue; the last
 * input hold of the session ended (`onInputsSettled`) -> submission. The host adds submission (its
 * last open submission ticket released) and draft_cleared; the socket adds command; the watcher adds
 * inbox.
 *
 * Clean exit, in order: stop every edge source, close the socket, apply the header-only rule (a
 * session file holding nothing but its header is removed only when the registrant says nothing
 * references the session - an unanswerable question keeps the file), then remove the endpoint.
 * A process that exits without disposing still removes its endpoint synchronously on `exit`.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "../../core/agent-session.ts";
import type {
	RegisterControlEndpointOptions,
	SessionControlDrainResult,
	SessionControlWakeReason,
} from "../../core/extensions/types.ts";
import type { EditorHoldState } from "../../core/external-admission.ts";
import type { TuiControlSurface } from "./session-control-commands.ts";
import type { ControlFeed } from "./session-control-feed.ts";
import { type TuiRegistryEntry, unregisterTuiEndpoint, unregisterTuiEndpointSync } from "./session-control-registry.ts";
import type { ControlServer } from "./session-control-server.ts";
import { onProcessContinue, type WakeScheduler } from "./session-control-wake.ts";

export interface TuiControlContext {
	readonly session: AgentSession;
	readonly agentDir: string;
	readonly surface: TuiControlSurface;
	readonly editorRevision: () => number;
}

export interface ActiveControlEndpoint {
	readonly socket: string;
	wake(reason: SessionControlWakeReason): void;
	noteState(): void;
	noteQuestions(): void;
	dispose(): Promise<void>;
}

export interface ActivationParts {
	readonly context: TuiControlContext;
	readonly options: RegisterControlEndpointOptions;
	readonly entry: TuiRegistryEntry;
	readonly server: ControlServer;
	readonly scheduler: WakeScheduler;
	readonly feed: ControlFeed;
	readonly stopInbox: () => void;
	readonly wake: (reason: SessionControlWakeReason) => Promise<SessionControlDrainResult>;
}

const REPORT_TEXT_LIMIT = 4_000;

export function activateControlEndpoint(parts: ActivationParts): ActiveControlEndpoint {
	const { context, feed, wake } = parts;
	const { session, surface } = context;
	session.externalAdmission.setEditorSource(() => editorHold(context));
	const unsubscribeSession = session.subscribe((event) => {
		if (event.type === "agent_start") {
			feed.publish("state");
		} else if (event.type === "agent_idle") {
			feed.publish("completion", { turn_epoch: session.externalAdmission.turnEpoch });
			feed.publish("state");
			void wake("idle");
		} else if (
			event.type === "agent_end" ||
			event.type === "queue_update" ||
			event.type === "compaction_start" ||
			event.type === "compaction_end"
		) {
			feed.publish("state");
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			feed.publish("report", { text: assistantText(event.message).slice(0, REPORT_TEXT_LIMIT) });
		}
	});
	const unsubscribeEmitted = session.externalAdmission.onEmitted(() => void wake("emitted"));
	// Deferred like the host's release: an accepted prompt marks its run active right after.
	const unsubscribeInputs = session.externalAdmission.onInputsSettled(() =>
		queueMicrotask(() => void wake("submission")),
	);
	const stopContinue = onProcessContinue(() => void wake("continue"));
	const exitCleanup = (): void => unregisterTuiEndpointSync(parts.entry);
	process.once("exit", exitCleanup);
	let disposing: Promise<void> | undefined;
	const dispose = (): Promise<void> => {
		disposing ??= (async () => {
			process.removeListener("exit", exitCleanup);
			unsubscribeSession();
			unsubscribeEmitted();
			unsubscribeInputs();
			stopContinue();
			parts.stopInbox();
			parts.scheduler.dispose();
			feed.clear();
			session.externalAdmission.setEditorSource(undefined);
			await parts.server.close();
			if (!(await sessionReferenced(parts.options, surface))) await session.sessionManager.discardHeaderOnlyFile();
			await unregisterTuiEndpoint(parts.entry);
		})();
		return disposing;
	};
	return {
		socket: parts.entry.socket,
		wake: (reason) => void wake(reason),
		noteState: () => feed.publish("state"),
		noteQuestions: () => feed.publish("question", { pending: [...surface.pendingQuestionIds()] }),
		dispose,
	};
}

function editorHold(context: TuiControlContext): EditorHoldState {
	const hold = context.surface.draftHold();
	const revision = context.editorRevision();
	return hold === undefined ? { revision } : { hold_reason: hold, revision };
}

async function sessionReferenced(
	options: RegisterControlEndpointOptions,
	surface: TuiControlSurface,
): Promise<boolean> {
	if (options.isSessionReferenced === undefined) return false;
	try {
		return await options.isSessionReferenced();
	} catch (error) {
		surface.notice(
			`control endpoint kept the session file: ${error instanceof Error ? error.message : String(error)}`,
		);
		return true;
	}
}

function assistantText(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}
