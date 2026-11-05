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
import { createHandSelection, type HandDirectory, type HandSelection } from "./hand-selection.ts";
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
	const handSelection = hands === undefined ? undefined : createHandSelection(hands);
	// The recorded hand is installed before presence gates the session, so a split session's calls wait for presence.
	const withHands = handSelection === undefined ? host.createRuntime : handRuntime(host.createRuntime, handSelection);
	return {
		...host,
		sessionOwner: "machine",
		listen: options.listen ?? `unix://${headlessSocketPath(options.agentDir)}`,
		createRuntime: presence === undefined ? withHands : presenceRuntime(withHands, presence),
		...(presence === undefined ? {} : { sessionPresence: presence.presence }),
		...(handSelection === undefined ? {} : { handSelection }),
	};
}

function handRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	selection: HandSelection,
): CreateAgentSessionRuntimeFactory {
	const restored: CreateAgentSessionRuntimeFactory = async (input) => {
		const runtime = await createRuntime(input);
		selection.restore(runtime.session.sessionId, runtime.session);
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
