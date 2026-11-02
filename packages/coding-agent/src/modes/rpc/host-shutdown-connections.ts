import type { Duplex } from "node:stream";
import type { RpcConnectionSink } from "./connection-handler.ts";
import { CHILD_STOP_TIMEOUT_MS } from "./host-stop-intent.ts";
import type { SocketClosingCode } from "./socket-closing.ts";

export interface HostConnection {
	readonly id: string;
	readonly sink: RpcConnectionSink;
	readonly socket: Duplex;
	readonly detach: () => void;
	/** RULING-124: every host close names its reason; a compact peer is told before its socket closes. */
	readonly close: (code: SocketClosingCode) => Promise<void>;
}

/**
 * What the supervisor's SIGTERM-to-SIGKILL window (`CHILD_STOP_TIMEOUT_MS`) must keep after the connection phase: the
 * listener close, the socket unlink and the process exit, measured at ~1.1 s on an idle machine and ~2.4 s under load.
 */
const HOST_EXIT_RESERVE_MS = 3_000;

/** How long a socket host's own shutdown may spend on its connections, so the whole stop fits the window. */
const HOST_SHUTDOWN_BUDGET_MS = CHILD_STOP_TIMEOUT_MS - HOST_EXIT_RESERVE_MS;

/**
 * The connection phase of a socket host's shutdown, after its sessions closed: drain every peer's queue, announce and
 * close each connection (`host_shutdown`), detach it. Every wait shares one deadline, `startedAt` plus the budget, so a
 * peer that never reads holds none of them past it, and a socket still open then (its half-close grace not yet spent)
 * is destroyed at the deadline: the grace is min(SOCKET_CUT_GRACE_MS, remaining budget). Returns the force's cancel.
 */
export async function closeHostConnections(
	connections: readonly HostConnection[],
	flush: () => Promise<void>,
	startedAt: number,
	log: (message: string) => void,
): Promise<() => void> {
	const deadline = startedAt + HOST_SHUTDOWN_BUDGET_MS;
	await beforeDeadline(flush(), deadline);
	await beforeDeadline(Promise.all(connections.map((connection) => connection.close("host_shutdown"))), deadline);
	for (const connection of connections) connection.detach();
	const force = setTimeout(
		() => {
			const open = connections.filter(({ socket }) => !socket.destroyed);
			if (open.length === 0) return;
			log(`shutdown budget spent after ${Date.now() - startedAt} ms; destroying ${open.length} open connection(s)`);
			for (const { socket } of open) socket.destroy();
		},
		Math.max(0, deadline - Date.now()),
	);
	return () => clearTimeout(force);
}

/** Settles with `work`, or once `deadline` passes with `work` still pending; a rejection of `work` propagates. */
function beforeDeadline(work: Promise<unknown>, deadline: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
	});
	return Promise.race([work.then(() => undefined), expired]).finally(() => clearTimeout(timer));
}
