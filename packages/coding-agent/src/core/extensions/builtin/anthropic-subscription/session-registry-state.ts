export type AnthropicSubscriptionSessionState =
	| "ABSENT"
	| "STARTING"
	| "IDLE_SYNCED"
	| "TURN_WAITING"
	| "TURN_SENT"
	| "TURN_CLAIMED"
	| "TURN_STREAMING"
	| "TURN_RESULT_SEEN"
	| "TAINTED"
	| "CLOSING"
	| "CLOSED"
	| "BROKEN";

type StatefulSession = { state: AnthropicSubscriptionSessionState };

const allowedTransitions: Readonly<
	Record<AnthropicSubscriptionSessionState, readonly AnthropicSubscriptionSessionState[]>
> = {
	ABSENT: ["STARTING"],
	STARTING: ["IDLE_SYNCED", "TAINTED", "CLOSING", "BROKEN"],
	IDLE_SYNCED: ["TURN_WAITING", "TAINTED", "CLOSING", "BROKEN"],
	TURN_WAITING: ["TURN_SENT", "TAINTED", "CLOSING", "BROKEN"],
	TURN_SENT: ["TURN_CLAIMED", "TAINTED", "CLOSING", "BROKEN"],
	TURN_CLAIMED: ["TURN_STREAMING", "TAINTED", "CLOSING", "BROKEN"],
	TURN_STREAMING: ["TURN_RESULT_SEEN", "TAINTED", "CLOSING", "BROKEN"],
	TURN_RESULT_SEEN: ["IDLE_SYNCED", "TAINTED", "CLOSING", "BROKEN"],
	TAINTED: ["CLOSING", "BROKEN"],
	CLOSING: ["CLOSED", "BROKEN"],
	CLOSED: [],
	BROKEN: ["CLOSING", "CLOSED"],
};

export function transitionSessionState<T extends StatefulSession>(
	entry: T,
	next: AnthropicSubscriptionSessionState,
): T {
	if (!allowedTransitions[entry.state].includes(next)) {
		throw new Error(`Illegal session state transition: ${entry.state} -> ${next}`);
	}
	entry.state = next;
	return entry;
}

export const transitionToStarting = <T extends StatefulSession>(entry: T): T =>
	transitionSessionState(entry, "STARTING");
export const transitionToIdleSynced = <T extends StatefulSession>(entry: T): T =>
	transitionSessionState(entry, "IDLE_SYNCED");
export const transitionToTurnWaiting = <T extends StatefulSession>(entry: T): T =>
	transitionSessionState(entry, "TURN_WAITING");
export const transitionToTurnSent = <T extends StatefulSession>(entry: T): T =>
	transitionSessionState(entry, "TURN_SENT");
export const transitionToTurnClaimed = <T extends StatefulSession>(entry: T): T =>
	transitionSessionState(entry, "TURN_CLAIMED");
export const transitionToTurnStreaming = <T extends StatefulSession>(entry: T): T =>
	transitionSessionState(entry, "TURN_STREAMING");
export const transitionToTurnResultSeen = <T extends StatefulSession>(entry: T): T =>
	transitionSessionState(entry, "TURN_RESULT_SEEN");
export const transitionToTainted = <T extends StatefulSession>(entry: T): T => transitionSessionState(entry, "TAINTED");
export const transitionToClosing = <T extends StatefulSession>(entry: T): T => transitionSessionState(entry, "CLOSING");
export const transitionToClosed = <T extends StatefulSession>(entry: T): T => transitionSessionState(entry, "CLOSED");
export const transitionToBroken = <T extends StatefulSession>(entry: T): T => transitionSessionState(entry, "BROKEN");
