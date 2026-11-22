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

/**
 * The deadline of a socket host's shutdown, counted from its start (the SIGTERM handler) to the forced close of its last
 * connection. It includes `router.dispose()`, which is not bounded on POSIX (#5398): a session that does not settle can
 * spend this budget, and the stop window, before the connection phase begins.
 */
export const HOST_SHUTDOWN_BUDGET_MS = CHILD_STOP_TIMEOUT_MS - HOST_EXIT_RESERVE_MS;

/**
 * The connection phase of a socket host's shutdown, after its sessions closed: each connection drains its own queue,
 * then is announced and closed (`host_shutdown`), independently of the others, so a peer that never reads holds only
 * itself; then every connection detaches. All waits share one deadline, `startedAt` plus the budget, and a socket still
 * open then (its half-close grace not yet spent) is destroyed at it: the grace is min(SOCKET_CUT_GRACE_MS, remaining
 * budget). Returns the force's cancel.
 */
export async function closeHostConnections(
	connections: readonly HostConnection[],
	drain: (id: string) => Promise<void>,
	startedAt: number,
	log: (message: string) => void,
): Promise<() => void> {
	const deadline = startedAt + HOST_SHUTDOWN_BUDGET_MS;
	await Promise.all(
		connections.map(async (connection) => {
			await beforeDeadline(drain(connection.id), deadline);
			await beforeDeadline(connection.close("host_shutdown"), deadline);
		}),
	);
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
