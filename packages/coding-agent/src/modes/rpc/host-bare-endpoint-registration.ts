/**
 * The registry record of a socket host that binds its own public socket (`--listen`, `--headless`). No
 * `host ensure` runs for such a host, so nothing else writes its `endpoint.json`, and `host gc` removes the
 * record with the rest of a dead endpoint's directory: after one outage the restarted host would serve
 * while every registry reader (`host status --all`, a relay device service) finds nothing (senpi#6190).
 *
 * So the host writes the record itself before it serves, and binds inside the endpoint's ensure lock, the
 * lock `host gc` judges and removes under: a gc that judged the socket dead has finished its removal
 * before this write, and one that starts later finds the socket bound and keeps the endpoint. A supervised
 * host never comes here - its ensure wrote the record and holds that lock while it starts the host.
 */
import { createDaemonDirectories, createHostDaemonPaths } from "./host-daemon-paths.ts";
import { acquireHostEnsureLock } from "./host-ensure-lock.ts";

/** Longer than a gc's hold of one endpoint (its 2 s lock wait, the evidence probes, the removal). */
const REGISTRATION_LOCK_WAIT_MS = 10_000;

export interface BareEndpointRegistration {
	readonly agentDir: string;
	readonly socket: string;
	readonly log: (message: string) => void;
}

export async function bindRegisteredEndpoint<T>(
	registration: BareEndpointRegistration,
	bind: () => Promise<T>,
): Promise<T> {
	// An abstract socket has no path, so it has no daemon directory either.
	if (registration.socket.startsWith("\0")) return bind();
	const release = await acquireHostEnsureLock(registration.socket, REGISTRATION_LOCK_WAIT_MS).catch(
		(cause: unknown) => {
			registration.log(`endpoint ensure lock unavailable, registering without it: ${messageOf(cause)}`);
			return undefined;
		},
	);
	try {
		await createDaemonDirectories(
			createHostDaemonPaths({ socket: registration.socket, agentDir: registration.agentDir }),
		).catch((cause: unknown) => registration.log(`endpoint registry record not written: ${messageOf(cause)}`));
		return await bind();
	} finally {
		await release?.();
	}
}

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
