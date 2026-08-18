import { join } from "node:path";
import type { BridgeConnectionConfig, KernelToHostMessage } from "../../bridge/protocol.ts";
import { type CodemodeRuntimeAssetEnvironment, resolveCodemodeRuntimeAsset } from "../shared/runtime-asset.ts";
import { SubprocessKernel, type SubprocessSpawn } from "../shared/subprocess-kernel.ts";

export interface RubyKernelStartOptions {
	readonly cwd: string;
	readonly sessionId: string;
	readonly connection: BridgeConnectionConfig;
	readonly command?: string;
	readonly spawn?: SubprocessSpawn;
	readonly onMessage?: (message: KernelToHostMessage) => void;
}

export interface RubyRunnerPathOptions extends CodemodeRuntimeAssetEnvironment {
	readonly localPath?: string;
}

export function resolveRubyRunnerPath(options: RubyRunnerPathOptions = {}): string {
	return resolveCodemodeRuntimeAsset(
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
			connection: options.connection,
			spawn: options.spawn,
			onMessage: options.onMessage,
		});
	}
}
