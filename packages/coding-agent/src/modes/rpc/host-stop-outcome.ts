import type { HostRequest } from "./host-runner.ts";
import { HOST_EXIT_OK, HOST_EXIT_REFUSED, type HostOutcome, refusal } from "./host-outcome.ts";
import { probeProtocolInfo } from "./host-probe.ts";
import { readSessionCounts } from "./host-status.ts";
import { staleStopGeneration, stopHost } from "./host-stop.ts";

/** Conditional drains have no client census: only the child can decide and close admission atomically. */
export async function stopOutcome(request: Extract<HostRequest, { action: "stop" }>): Promise<HostOutcome> {
	const { target, drain, force, instanceId, waitMs } = request;
	if (request.ifIdle === true) {
		const result = await stopHost({ ...target, drain, instanceId, waitMs, ifIdle: true });
		return { exitCode: result.action === "refuse" ? HOST_EXIT_REFUSED : HOST_EXIT_OK, payload: { ...result } };
	}
	if (request.expectedGeneration !== undefined) {
		const stale = await staleStopGeneration(target.socket, target.agentDir, request.expectedGeneration);
		if (stale !== undefined) return refusal("refuse", undefined, { reason: stale.reason, socket: target.socket });
	}
	const host = await probeProtocolInfo(target.socket, 10_000);
	const sessions = await readSessionCounts(target.socket, true);
	const occupied = sessions.foreign_attached + sessions.foreign_retained > 0;
	if (!drain && !force && occupied) {
		return refusal("refuse", host, { reason: "sessions_live", socket: target.socket, sessions });
	}
	const result = await stopHost({
		socket: target.socket,
		agentDir: target.agentDir,
		drain,
		force,
		...(request.expectedGeneration !== undefined && { expectedGeneration: request.expectedGeneration }),
		...(instanceId !== undefined && { instanceId }),
		...(waitMs !== undefined && { waitMs }),
	});
	if (result.action === "refuse") {
		return refusal("refuse", host, { reason: result.reason, socket: target.socket, sessions });
	}
	return {
		exitCode: HOST_EXIT_OK,
		payload: {
			action: result.action,
			socket: target.socket,
			pid: result.pid,
			...("instanceId" in result && result.instanceId !== undefined && { instanceId: result.instanceId }),
			...("exited" in result && result.exited !== undefined && { exited: result.exited }),
			sessions,
		},
	};
}
