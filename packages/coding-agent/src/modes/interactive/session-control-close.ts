/**
 * `unload_session { graceful: true }` on a terminal's control endpoint (oh-my-openagent#14313). A terminal's own
 * session closes only gracefully, and only with an empty composer: the drain is the host's (`session-graceful-close.ts`),
 * the answer is the host's shape, and once it is sent the terminal exits by itself, as a person's quit would.
 */
import type { AgentSession } from "../../core/agent-session.ts";
import {
	drainFacts,
	drainUntilQuiet,
	fenceForClose,
	type GracefulDrain,
	gracefulWaitMs,
	recordGracefulClose,
	reopenAfterDrain,
} from "../rpc/session-graceful-close.ts";
import type { ControlCommandContext } from "./session-control-commands.ts";
import { type ControlCommand, type ControlConnection, success } from "./session-control-server.ts";

const COMMAND = "unload_session";

const DRAFT_ACTION = "send or clear the composer in that terminal, then close it again";
const EXPIRED_ACTION =
	"the terminal is still open and admitting again: retry with a longer waitMs, or interrupt its turn first";

function terminalBusy(session: AgentSession): string[] {
	const activity = session.activitySnapshot;
	return [
		activity.isStreaming && "an agent run",
		activity.isCompacting && "compaction",
		activity.hasSessionWork && "session work",
		activity.isBashRunning && "a bash command",
		session.externalAdmission.list().pending.length > 0 && "an admitted delivery not yet written",
	].filter((label): label is string => typeof label === "string");
}

function refusedDraft(context: ControlCommandContext, command: ControlCommand, drain?: GracefulDrain): object {
	return success(command.id, COMMAND, {
		outcome: "refused",
		reason: "composer_draft",
		detail: "the terminal's composer holds an unsent draft; closing would discard it",
		action: DRAFT_ACTION,
		...(drain === undefined ? {} : { dropped: drain.dropped, open: true, admission: "reopened" }),
	});
}

export async function closeTerminalGracefully(
	context: ControlCommandContext,
	connection: ControlConnection,
	command: ControlCommand,
): Promise<object | null> {
	const { session, surface } = context;
	if (command.graceful !== true)
		return success(command.id, COMMAND, {
			outcome: "refused",
			reason: "unsupported",
			detail: "a terminal's own session closes only with graceful: true, and its terminal then exits",
		});
	if (surface.hasDraft()) return refusedDraft(context, command);
	const drain = fenceForClose(session);
	const waitMs = gracefulWaitMs(typeof command.waitMs === "number" ? command.waitMs : undefined);
	const quiet = await drainUntilQuiet(session, { busy: () => terminalBusy(session), settling: () => [] }, waitMs);
	if (!quiet) {
		reopenAfterDrain(session);
		return success(command.id, COMMAND, {
			outcome: "refused",
			reason: "turn_active",
			detail: `still working after ${waitMs} ms: ${terminalBusy(session).join(", ")}`,
			action: EXPIRED_ACTION,
			dropped: drain.dropped,
			timed_out: true,
			open: true,
			admission: "reopened",
			...drainFacts(session, drain),
		});
	}
	// The person may have started typing while the turn ended: their text is never discarded by a close.
	if (surface.hasDraft()) {
		reopenAfterDrain(session);
		return refusedDraft(context, command, drain);
	}
	const closed = recordGracefulClose(session, drain);
	connection.send(
		success(command.id, COMMAND, {
			outcome: "unloaded",
			sessionPath: session.sessionFile ?? null,
			dropped: drain.dropped,
			graceful: { turn: closed.turn, waited_ms: closed.waited_ms, stopped: closed.stopped },
		}),
	);
	surface.closeSession();
	return null;
}
