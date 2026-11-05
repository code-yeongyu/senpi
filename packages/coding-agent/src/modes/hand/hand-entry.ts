/**
 * The engine as a hand (`--hand`, senpi#5840): loopless runtimes per execution scope (`createLooplessHand`) serving the
 * remote executor, its device file channel and the scopes' loop hooks on one local endpoint, through the reference
 * transport over {@link serveSocketCarrier}. It never runs a loop and opens no transcript; the process lives until it is
 * signalled.
 */
import { createServer } from "node:net";
import { posix, win32 } from "node:path";
import {
	createReliableTransport,
	createRemoteExecutor,
	serveLoopHooks,
	type Transport,
} from "@earendil-works/pi-agent-core";
import type { InlineExtension } from "../../core/extensions/types.ts";
import type { CliRuntimeConfiguration } from "../../main.ts";
import { closeServer, prepareSocketPath } from "../rpc/host-lifecycle-proxy.ts";
import { listen } from "../rpc/host-socket-bind.ts";
import { createLooplessHand } from "../rpc/remote-executor-scope.ts";
import { shieldSocketDuringClose, unlinkOwnedSocket } from "../rpc/socket-ownership.ts";
import { resolveSocketTransportAddress } from "../rpc/socket-transport.ts";
import { serveSocketCarrier } from "./socket-carrier.ts";

type FrameHandler = Parameters<Transport["onFrame"]>[0];

/** The lane the loop hooks of a hand's scopes travel on; every other lane is the remote executor's. */
const HAND_LOOP_HOOK_LANE = "loop-hooks";

export function handSocketPath(agentDir: string, platform: NodeJS.Platform = process.platform): string {
	return (platform === "win32" ? win32 : posix).join(agentDir, "rpc", "hand.sock");
}

/** The address a carrier dials: the socket path on POSIX, its named pipe on Windows. */
function handEndpoint(agentDir: string, platform: NodeJS.Platform = process.platform): string {
	return resolveSocketTransportAddress(handSocketPath(agentDir, platform), platform);
}

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

export interface HandEntryOptions {
	readonly configuration: CliRuntimeConfiguration;
	readonly extensionFactories?: InlineExtension[];
}

export async function runHand(options: HandEntryOptions): Promise<never> {
	const { agentDir } = options.configuration;
	const report = (message: string): void => void process.stderr.write(`senpi hand: ${message}\n`);
	const hand = createLooplessHand(options.configuration, {
		...(options.extensionFactories === undefined ? {} : { extensionFactories: options.extensionFactories }),
	});
	const transport = createReliableTransport({
		clock: {
			now: () => Date.now(),
			setTimer: (callback, ms) => {
				const timer = setTimeout(callback, ms);
				return () => clearTimeout(timer);
			},
		},
		onHandlerError: (error) => report(`frame handler failed: ${String(error)}`),
	});
	const lanes = splitLane(transport, HAND_LOOP_HOOK_LANE);
	const executor = createRemoteExecutor({
		authority: { kind: "self" },
		fileChannel: true,
		transport: lanes.rest,
		openScope: hand.openScope,
		onFault: (error) => report(`call fault: ${String(error)}`),
	});
	const loopHooks = serveLoopHooks({
		transport: lanes.own,
		lane: HAND_LOOP_HOOK_LANE,
		run: hand.loopHooks,
		onFault: (error) => report(`loop hook fault: ${String(error)}`),
	});

	const socketPath = handSocketPath(agentDir);
	// Refuses an entry a live hand still serves; only a dead (stale) entry is removed.
	await prepareSocketPath(socketPath);
	const server = createServer();
	serveSocketCarrier(server, transport);
	const boundIdentity = await listen(server, socketPath);
	report(`listening on ${handEndpoint(agentDir)}`);

	return new Promise<never>(() => {
		const stop = async (): Promise<void> => {
			let exitCode = 0;
			const step = async (name: string, run: () => unknown): Promise<void> => {
				try {
					await run();
				} catch (error) {
					exitCode = 1;
					report(`${name} failed during shutdown: ${String(error)}`);
				}
			};
			// libuv unlinks the bound name on close, which would delete a newer hand's entry: shield it for the close,
			// then remove only the entry this process bound.
			await step("listener close", () => shieldSocketDuringClose(socketPath, () => closeServer(server)));
			await step("loop hooks", () => loopHooks.close());
			await step("transport", () => transport.close());
			await step("executor", () => executor.close());
			await step("hand runtimes", () => hand.close());
			await step("socket removal", () => unlinkOwnedSocket(socketPath, boundIdentity, report));
			process.exit(exitCode);
		};
		process.once("SIGTERM", () => void stop());
		process.once("SIGINT", () => void stop());
	});
}
