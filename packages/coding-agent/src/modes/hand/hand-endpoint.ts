/**
 * The hand engine on one transport (senpi#5840): agent-core's remote executor (with its device file channel) on every
 * lane but `loop-hooks`, and the scopes' loop hooks on that lane. `--hand` serves it over its socket carrier; the RPC
 * host's `hand_link` serves one per hosted session over relayed packet batches (R3).
 */
import {
	createRemoteExecutor,
	type HandAuthority,
	type HandEpochFence,
	serveLoopHooks,
	type Transport,
} from "@earendil-works/pi-agent-core";
import type { LooplessHand } from "../rpc/remote-executor-scope.ts";

type FrameHandler = Parameters<Transport["onFrame"]>[0];

/** The lane the loop hooks of a hand's scopes travel on; every other lane is the remote executor's. */
export const HAND_LOOP_HOOK_LANE = "loop-hooks";

/** One transport seen as two: frames on `lane` go to one view's receiver, every other frame to the other's. */
function splitLane(transport: Transport, lane: string): { readonly own: Transport; readonly rest: Transport } {
	let ownHandler: FrameHandler | undefined;
	let restHandler: FrameHandler | undefined;
	transport.onFrame((frame) => (frame.lane === lane ? ownHandler : restHandler)?.(frame));
	const view = (set: (handler: FrameHandler) => void): Transport => ({
		send: (to, payload) => transport.send(to, payload),
		onFrame: set,
		inFlight: (to) => transport.inFlight(to),
		close: () => transport.close(),
	});
	return {
		own: view((handler) => {
			ownHandler = handler;
		}),
		rest: view((handler) => {
			restHandler = handler;
		}),
	};
}

export interface HandEndpointOptions {
	readonly transport: Transport;
	readonly openScope: LooplessHand["openScope"];
	readonly loopHooks: LooplessHand["loopHooks"];
	readonly authority: HandAuthority;
	/** The hand's epoch floors (S35); without it a floor is refused `epoch_unsupported`. */
	readonly fence?: HandEpochFence;
	readonly report: (message: string) => void;
}

export interface HandEndpoint {
	/** Stops the loop hooks, then the executor: running calls are aborted, its scopes disposed, the transport closed. */
	close(): Promise<void>;
}

export function createHandEndpoint(options: HandEndpointOptions): HandEndpoint {
	const { report } = options;
	const lanes = splitLane(options.transport, HAND_LOOP_HOOK_LANE);
	const executor = createRemoteExecutor({
		authority: options.authority,
		fileChannel: true,
		transport: lanes.rest,
		openScope: options.openScope,
		...(options.fence === undefined ? {} : { fence: options.fence }),
		onFault: (error) => report(`call fault: ${String(error)}`),
	});
	const loopHooks = serveLoopHooks({
		transport: lanes.own,
		lane: HAND_LOOP_HOOK_LANE,
		run: options.loopHooks,
		onFault: (error) => report(`loop hook fault: ${String(error)}`),
	});
	return {
		async close() {
			loopHooks.close();
			await executor.close();
		},
	};
}
