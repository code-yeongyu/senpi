/**
 * The headless engine: a multi-session RPC host with no UI that OWNS its sessions and their loops.
 * Clients and other sessions attach and detach over RPC; a detach never ends a session or a running
 * turn, and the engine does not exit for being empty. It needs only the engine's own configuration
 * (an agent dir, a cwd, a runtime factory) and reads nothing product-specific.
 */
import { posix, win32 } from "node:path";
import type {
	CreateAgentSessionRuntimeFactory,
	CreateAgentSessionRuntimeResult,
} from "../../core/agent-session-runtime.ts";
import type { MultiSessionHostOptions } from "../rpc/multi-session-host.ts";
import { resolveSocketTransportAddress } from "../rpc/socket-transport.ts";
import type { HeadlessPresence } from "./presence.ts";
import {
	createHandSelection,
	type HandDirectory,
	type HandSelection,
	type HandSelectionOptions,
} from "./hand-selection.ts";
import { gatePresence } from "./presence-gates.ts";

/** The headless engine's socket under `<agentDir>/rpc/`, apart from the shared host's `rpc.sock`. */
const HEADLESS_SOCKET_FILE = "headless.sock";

/** Off unless set: each session's presence and its gates (C2, K7; senpi#5652). No CLI flag sets it yet. */
export interface HeadlessPresenceBinding {
	readonly presence: HeadlessPresence;
	/** The hand machines a session's tool calls run on; empty for a fused session. */
	readonly handsOf: (runtime: CreateAgentSessionRuntimeResult) => readonly string[];
}

export type HeadlessHostOptions = Omit<
	MultiSessionHostOptions,
	"sessionOwner" | "sessionPresence" | "handSelection"
> & {
	readonly presence?: HeadlessPresenceBinding;
	/** Off unless set: the hands a session's tools can run on (R4); each session's choice is recorded in its file. */
	readonly hands?: HandDirectory;
};

export function headlessSocketPath(agentDir: string, platform: NodeJS.Platform = process.platform): string {
	return (platform === "win32" ? win32 : posix).join(agentDir, "rpc", HEADLESS_SOCKET_FILE);
}

/** The address a client dials: the socket path on POSIX, its named pipe on Windows. */
export function headlessEndpoint(
	agentDir: string,
	platform: NodeJS.Platform = process.platform,
	secret?: Uint8Array,
): string {
	return resolveSocketTransportAddress(headlessSocketPath(agentDir, platform), platform, secret);
}

export function headlessHostOptions(options: HeadlessHostOptions): MultiSessionHostOptions {
	const { presence, hands, ...host } = options;
	const runtimes = new Map<string, CreateAgentSessionRuntimeResult>();
	const handSelection =
		hands === undefined
			? undefined
			: createHandSelection(hands, presence === undefined ? {} : presenceHooks(presence, runtimes));
	// Presence gates the session first; the hand selection then installs every host through the same gate, so a
	// chosen hand's calls wait for presence and `null` gives back the gated host the session started with.
	const gated = presence === undefined ? host.createRuntime : presenceRuntime(host.createRuntime, presence);
	return {
		...host,
		sessionOwner: "machine",
		listen: options.listen ?? `unix://${headlessSocketPath(options.agentDir)}`,
		createRuntime: handSelection === undefined ? gated : handRuntime(gated, handSelection, runtimes),
		...(presence === undefined ? {} : { sessionPresence: presence.presence }),
		...(handSelection === undefined ? {} : { handSelection }),
	};
}

/** The presence gate for a host the hand selection installs, and the hands presence tracks after each choice. */
function presenceHooks(
	binding: HeadlessPresenceBinding,
	runtimes: ReadonlyMap<string, CreateAgentSessionRuntimeResult>,
): HandSelectionOptions {
	// The presence update for each session's latest choice: a tool batch waits for it before asking presence, so it
	// is gated on the hand it will run on, and a failed update fails that batch instead of going unhandled.
	const tracking = new Map<string, Promise<void>>();
	return {
		gate: (sessionId, host) => ({
			execute: async (call, options) => {
				await tracking.get(sessionId);
				await binding.presence.ready(sessionId, "tools", options.signal);
				return host.execute(call, options);
			},
		}),
		onChange: (sessionId, device) => {
			const runtime = runtimes.get(sessionId);
			const sessionHands = device !== null ? [device] : runtime === undefined ? [] : binding.handsOf(runtime);
			const update = binding.presence.track(sessionId, sessionHands);
			update.catch(() => {});
			tracking.set(sessionId, update);
		},
		onRelease: (sessionId) => {
			tracking.delete(sessionId);
		},
	};
}

function handRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	selection: HandSelection,
	runtimes: Map<string, CreateAgentSessionRuntimeResult>,
): CreateAgentSessionRuntimeFactory {
	const restored: CreateAgentSessionRuntimeFactory = async (input) => {
		const runtime = await createRuntime(input);
		const { session } = runtime;
		const sessionId = session.sessionId;
		runtimes.set(sessionId, runtime);
		selection.restore(sessionId, session);
		// A session that ends releases its link to the hand; a later runtime of the same id starts clean.
		const dispose = session.dispose.bind(session);
		session.dispose = () => {
			if (runtimes.get(sessionId) === runtime) {
				runtimes.delete(sessionId);
				selection.release(sessionId);
			}
			dispose();
		};
		return runtime;
	};
	return Object.assign(restored, createRuntime);
}

function presenceRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	binding: HeadlessPresenceBinding,
): CreateAgentSessionRuntimeFactory {
	const tracked: CreateAgentSessionRuntimeFactory = async (input) => {
		const runtime = await createRuntime(input);
		const { session } = runtime;
		await binding.presence.track(session.sessionId, binding.handsOf(runtime));
		gatePresence(session.agent, binding.presence, session.sessionId);
		return runtime;
	};
	return Object.assign(tracked, createRuntime);
}
