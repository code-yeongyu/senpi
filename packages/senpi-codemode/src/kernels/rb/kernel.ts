import { join } from "node:path";
import type { BridgeConnectionConfig, KernelToHostMessage } from "../../bridge/protocol.ts";
import type { SessionEnvironment } from "../session-env.ts";
import type { KernelLifecycle } from "../shared/kernel-death.ts";
import { type CodemodeRuntimeAssetEnvironment, requireCodemodeRuntimeAsset } from "../shared/runtime-asset.ts";
import { SubprocessKernel, type SubprocessKernelMemory, type SubprocessSpawn } from "../shared/subprocess-kernel.ts";

export interface RubyKernelStartOptions extends KernelLifecycle {
	readonly cwd: string;
	readonly sessionId: string;
	readonly connection: BridgeConnectionConfig;
	/** Per-session PI_* values merged into the interpreter environment at spawn. */
	readonly sessionEnv?: SessionEnvironment;
	readonly command?: string;
	readonly spawn?: SubprocessSpawn;
	readonly onMessage?: (message: KernelToHostMessage) => void;
	/** Memory management: the runner reports its largest globals and the host reads the interpreter footprint for the ceiling. */
	readonly memory?: SubprocessKernelMemory;
}

export interface RubyRunnerPathOptions extends CodemodeRuntimeAssetEnvironment {
	readonly localPath?: string;
}

export function resolveRubyRunnerPath(options: RubyRunnerPathOptions = {}): string {
	return requireCodemodeRuntimeAsset(
		options.localPath ?? join(import.meta.dirname, "runner.rb"),
		join("kernels", "rb", "runner.rb"),
		options,
	);
}

export class RubyKernel extends SubprocessKernel {
	static start(options: RubyKernelStartOptions): RubyKernel {
		return new RubyKernel({
			command: options.command ?? "ruby",
			args: [resolveRubyRunnerPath()],
			cwd: options.cwd,
			sessionId: options.sessionId,
			sessionEnv: options.sessionEnv,
			connection: options.connection,
			spawn: options.spawn,
			onMessage: options.onMessage,
			memory: options.memory && { language: "rb", ...options.memory },
			onDeath: options.onDeath,
		});
	}
}
