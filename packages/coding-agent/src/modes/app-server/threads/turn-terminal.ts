import type { ThreadId, Turn } from "../protocol/index.ts";
import type { TurnEngineNotification } from "./turn-runtime.ts";

type TurnNotificationEmitter = (threadId: string, notification: TurnEngineNotification) => void;

export function emitTurnTerminalNotifications(
	threadId: ThreadId,
	turn: Turn,
	emitToThread: TurnNotificationEmitter,
): void {
	if (turn.status === "failed" && turn.error !== null) {
		emitToThread(threadId, {
			method: "error",
			params: {
				threadId,
				turnId: turn.id,
				error: turn.error,
				willRetry: false,
			},
		});
	}
	emitToThread(threadId, { method: "turn/completed", params: { threadId, turn } });
}
