/**
 * The runtime-identity handover a POSIX socket host offers (code-yeongyu/oh-my-openagent#10091): the endpoint a
 * `begin_handover` is checked against and the coordinator's host-side ports. Split out of `multi-session-host.ts`;
 * the router supplies the rest (`session-router-handover.ts`).
 */
import type { Duplex } from "node:stream";
import type { HostCoreHooks } from "./host-core-gate.ts";
import { createHostDaemonPaths } from "./host-daemon-paths.ts";
import { createHandoverJournal } from "./host-handover-journal.ts";
import { performIdleHandover } from "./host-handover-wire.ts";
import { OVERLAP_HANDOVER_ENV } from "./host-idle-handover.ts";
import { hostGeneration, hostInstanceId } from "./protocol-identity.ts";
import type { RpcHostHandoverOverdueEvent } from "./rpc-host-lifecycle-types.ts";

export function socketHostHandover(context: {
	readonly agentDir: string;
	/** The PUBLIC endpoint: a supervised host's own listener is a private hop. */
	readonly socket: string;
	readonly runtimeBuildId: string;
	readonly presenterBootstrap: () => Duplex | undefined;
	readonly announce: (record: RpcHostHandoverOverdueEvent) => void;
	readonly log: (message: string) => void;
}): Required<Pick<HostCoreHooks, "endpoint" | "handover">> {
	const { agentDir, socket, runtimeBuildId } = context;
	return {
		endpoint: { agentDir, socket },
		handover: {
			identity: () => ({ instanceId: hostInstanceId(), generation: hostGeneration(process.env), runtimeBuildId }),
			perform: (request, deadline) =>
				performIdleHandover({
					presenterBootstrap: context.presenterBootstrap(),
					request,
					socket,
					agentDir,
					deadline,
				}),
			overlapEnabled: () => process.env[OVERLAP_HANDOVER_ENV] === "1",
			journal: createHandoverJournal(createHostDaemonPaths({ socket, agentDir }).dir),
			announce: context.announce,
			log: context.log,
		},
	};
}
