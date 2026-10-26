/**
 * Public lifecycle admission before credential mutation (sisyphuslabs/omo-desktop-app#4199, design 4.2a "Admission
 * BEFORE mutation"). On a Windows public endpoint the pipe name and the handshake both derive from the public secret, so
 * a missing or malformed secret makes every connection to a live owner fail; that failure is never proof that the owner
 * is gone. Before anything stops a host, clears a registration or writes a new secret, an ensure that finds the secret
 * missing or malformed takes a census of the recorded owners under the endpoint lock: a live or identity-unreadable
 * owner refuses with `public_secret_recovery_required` and nothing is mutated. Only an endpoint whose recorded owners
 * are proven gone proceeds to provision.
 */
import { HostEnsureRefusedError } from "./host-decision.ts";
import { generationPaths, type HostDaemonPaths } from "./host-daemon-paths.ts";
import type { RegisteredHost } from "./host-daemon-registration.ts";
import { resolvePidFileOwnership } from "./host-ensure-stop.ts";
import { readLegacyHost } from "./host-legacy.ts";
import { hostChildAlive } from "./host-stalled-evidence.ts";
import { classifySocketSecret, socketSecretPath } from "./socket-transport.ts";

/** Throws `public_secret_recovery_required` when the secret is unusable and a recorded owner may be live. */
export async function admitPublicSecretMutation(
	paths: HostDaemonPaths,
	socket: string,
	registered: RegisteredHost | undefined,
	readStartTime: ((pid: number) => Promise<string | undefined>) | undefined,
): Promise<void> {
	const credential = await classifySocketSecret(socketSecretPath(socket));
	if (credential === "valid") return;
	const evidence = await liveOwnerEvidence(paths, registered, readStartTime);
	if (evidence === undefined) return;
	throw new HostEnsureRefusedError(
		socket,
		"public_secret_recovery_required",
		undefined,
		`the public secret is ${credential} and ${evidence}`,
	);
}

async function liveOwnerEvidence(
	paths: HostDaemonPaths,
	registered: RegisteredHost | undefined,
	readStartTime: ((pid: number) => Promise<string | undefined>) | undefined,
): Promise<string | undefined> {
	if (registered) {
		const supervisor = await resolvePidFileOwnership(registered.record, readStartTime);
		if (supervisor === "owns") return `generation ${registered.instanceId} (pid ${registered.record.pid}) is live`;
		if (supervisor === "unknown") {
			return `generation ${registered.instanceId} (pid ${registered.record.pid}) has an unreadable identity`;
		}
		if ((await hostChildAlive(generationPaths(paths, registered.instanceId))) === true) {
			return `the host child of generation ${registered.instanceId} is live`;
		}
	}
	const legacy = await readLegacyHost(paths);
	if (legacy) {
		const owner = await resolvePidFileOwnership(legacy.record, readStartTime);
		if (owner !== "gone")
			return `a legacy host (pid ${legacy.record.pid}) is ${owner === "owns" ? "live" : "unknown"}`;
	}
	return undefined;
}
