import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import type { FakeTurn } from "./rpc-inprocess-host-support.ts";

export function commandStart() {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timeout = setTimeout(() => reject(new Error("Command handler did not start")), 5_000);
	return {
		started: promise.finally(() => clearTimeout(timeout)),
		markStarted: resolve,
	};
}

export const runsBash = (markStarted: () => void) => (turn: () => FakeTurn) => async (command: RpcCommand) => {
	if (command.type !== "bash") return;
	const ended = turn().startBash();
	markStarted();
	await ended;
};
