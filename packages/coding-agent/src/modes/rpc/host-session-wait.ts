import { HOST_EXIT_ERROR, HOST_EXIT_OK, type HostOutcome } from "./host-outcome.ts";
import type { RpcClient, RpcClientEvent, RpcTransportGoneError } from "./rpc-client.ts";
import type { RpcSessionClosedEvent, RpcSessionState } from "./rpc-types.ts";

export interface HostSessionWait {
	readonly until: "idle" | "done";
	readonly timeoutMs: number;
}

type TransportLossHandler = ((error: RpcTransportGoneError) => void) | undefined;

export function waitForHostSession(
	client: RpcClient,
	sessionId: string | undefined,
	request: HostSessionWait,
	onTransportLoss: (handler: TransportLossHandler) => void,
): Promise<HostOutcome> {
	const started = Date.now();
	return new Promise<HostOutcome>((resolveWait, reject) => {
		let finished = false;
		let observed = false;
		let state: RpcSessionState | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			finished = true;
			clearTimeout(timer);
			unsubscribe();
			onTransportLoss(undefined);
		};
		const fail = (error: unknown) => {
			if (finished) return;
			cleanup();
			reject(error);
		};
		const finish = (outcome: string) => {
			if (finished) return;
			cleanup();
			resolveWait({
				exitCode: HOST_EXIT_OK,
				payload: {
					action: "wait",
					sessionId,
					until: request.until,
					outcome,
					waited_ms: Date.now() - started,
					state: {
						isStreaming: state?.isStreaming ?? false,
						pendingMessageCount: state?.pendingMessageCount ?? 0,
						lastAbortSource: state?.lastAbortSource ?? null,
					},
				},
			});
		};
		// Subscribe BEFORE the snapshot, including when settlement arrives with that reply.
		const unsubscribe = client.onEvent((record) => {
			const event = record as RpcClientEvent | RpcSessionClosedEvent;
			if (event.type === "session_closed" || event.type === "session_parked") {
				finish(event.type);
				return;
			}
			if (event.type === "agent_settled" && "reason" in event && event.reason === "session_closed") {
				finish("session_closed");
				return;
			}
			if (event.type !== "agent_idle" && !(request.until === "done" && event.type === "agent_settled")) return;
			observed = true;
			void client.getState().then((snapshot) => {
				state = snapshot;
				if (request.until === "done") finish("done");
				else if (isDrained(snapshot)) finish("idle");
			}, fail);
		});
		onTransportLoss(fail);
		timer = setTimeout(() => {
			if (finished) return;
			cleanup();
			resolveWait({
				exitCode: HOST_EXIT_ERROR,
				payload: {
					action: "error",
					reason: "wait_timeout",
					sessionId,
					until: request.until,
					timeoutMs: request.timeoutMs,
				},
			});
		}, request.timeoutMs);
		void client.getState().then((snapshot) => {
			state = snapshot;
			// A parked steer keeps `idle` waiting: it only drains with the next prompt.
			if (!observed && (request.until === "done" ? !snapshot.isStreaming : isDrained(snapshot)))
				finish("already_idle");
		}, fail);
	});
}

function isDrained(state: RpcSessionState): boolean {
	return (
		!state.isStreaming &&
		state.steering.length === 0 &&
		state.followUp.length === 0 &&
		state.ordered.length === 0 &&
		state.pendingMessageCount === 0
	);
}
