import { ENV_AGENT_DIR, getAgentDir } from "../../config.ts";
import { RPC_CLIENT_CAPABILITIES_ENV } from "./custom-capability.ts";
import { daemonEnvironment } from "./host-daemon-env.ts";
import { HOST_DAEMON_DIR_ENV, type HostDaemonPaths } from "./host-daemon-paths.ts";
import { HOST_GENERATION_ENV, HOST_INSTANCE_ID_ENV } from "./host-identity-env.ts";
import { EXPECTED_RUNTIME_BUILD_ID_ENV } from "./host-idle-handover.ts";
import { PINNED_HOST_CLIENT_CAPABILITIES } from "./host-launch.ts";

export function initialHostEnvironment(options: {
	readonly agentDir?: string;
	readonly env?: Readonly<Record<string, string | null>>;
	readonly paths: HostDaemonPaths;
	readonly instanceId: string;
	readonly generation: number;
}): NodeJS.ProcessEnv {
	return daemonEnvironment(process.env, options.env, {
		[ENV_AGENT_DIR]: options.agentDir ?? getAgentDir(),
		[RPC_CLIENT_CAPABILITIES_ENV]: PINNED_HOST_CLIENT_CAPABILITIES.join(","),
		// Always SET, never inherited: two generations claiming one instance id make the handoff
		// completion signal - the instance id changing on the public socket - impossible to observe.
		[HOST_INSTANCE_ID_ENV]: options.instanceId,
		[HOST_GENERATION_ENV]: String(options.generation),
		[HOST_DAEMON_DIR_ENV]: options.paths.dir,
	});
}

export function successorHostEnvironment(options: {
	readonly agentDir?: string;
	readonly env?: Readonly<Record<string, string | null>>;
	readonly expectedRuntimeBuildId?: string | undefined;
	readonly paths: HostDaemonPaths;
	readonly instanceId: string;
	readonly generation: number;
}): NodeJS.ProcessEnv {
	return daemonEnvironment(process.env, options.env, {
		[RPC_CLIENT_CAPABILITIES_ENV]: PINNED_HOST_CLIENT_CAPABILITIES.join(","),
		...(options.agentDir ? { [ENV_AGENT_DIR]: options.agentDir } : {}),
		[HOST_INSTANCE_ID_ENV]: options.instanceId,
		[HOST_GENERATION_ENV]: String(options.generation),
		[HOST_DAEMON_DIR_ENV]: options.paths.dir,
		...(options.expectedRuntimeBuildId !== undefined && {
			[EXPECTED_RUNTIME_BUILD_ID_ENV]: options.expectedRuntimeBuildId,
		}),
	});
}
