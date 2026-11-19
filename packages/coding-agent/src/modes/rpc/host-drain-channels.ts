/**
 * How a drain request reaches a socket host, and which requests it honours (senpi#7044).
 *
 * - The supervisor's RELAY (`host-drain-request.json`, host-stop-intent.ts) is honoured: the supervisor decided the
 *   drain (`host stop --drain`, a lost public entry, a handoff this host admitted).
 * - SIGUSR1 is only that relay's immediate wake. One that no relayed request backs is ignored and logged: it used to
 *   BE the drain request, which let any client replace this host without asking it.
 * - An ADMITTED handoff (`drain_for_handoff`, host-handoff-admission.ts) goes through the supervisor too. The host
 *   writes its own generation's drain request, so the supervisor stops admitting before its host leaves, in the
 *   order a drain always had. A host with no supervisor drains itself.
 */
import { errorMessage } from "./host-supervisor-log.ts";
import { hostChildGeneration, readDrainRequest, watchDrainRequest, writeDrainRequest } from "./host-stop-intent.ts";

export interface HostDrainChannels {
	/** Starts the drain of a handoff this host admitted. */
	drainForAdmittedHandoff(): void;
}

export function armHostDrainChannels(host: {
	/** The host's own drain; calling it again while draining only rescans. */
	readonly drain: () => void;
	readonly draining: () => boolean;
	readonly log: (message: string) => void;
}): HostDrainChannels {
	const generation = hostChildGeneration();
	if (generation !== undefined) watchDrainRequest(generation.childDrainRequestFile, host.drain);
	if (process.platform !== "win32") {
		process.on("SIGUSR1", () => {
			if (host.draining()) {
				host.drain();
				return;
			}
			const relayed =
				generation === undefined ? Promise.resolve(undefined) : readDrainRequest(generation.childDrainRequestFile);
			void relayed.then((request) => {
				if (request !== undefined) host.drain();
				else
					host.log(
						"ignored SIGUSR1: no drain request backs it (a handoff is admitted, not signalled); still serving",
					);
			});
		});
	}
	return {
		drainForAdmittedHandoff: () => {
			if (generation === undefined) {
				host.drain();
				return;
			}
			void writeDrainRequest(generation.drainRequestFile, {
				sender: { pid: process.pid, kind: "handoff" },
				reason: "admitted_handoff",
			}).catch((cause: unknown) => {
				host.log(`could not ask the supervisor to drain (${errorMessage(cause)}); draining this host alone`);
				host.drain();
			});
		},
	};
}
