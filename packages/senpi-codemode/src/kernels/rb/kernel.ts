import { join } from "node:path";
import type { BridgeConnectionConfig, KernelToHostMessage } from "../../bridge/protocol.ts";
import { SubprocessKernel, type SubprocessSpawn } from "../shared/subprocess-kernel.ts";

export interface RubyKernelStartOptions {
	readonly cwd: string;
	readonly sessionId: string;
	readonly connection: BridgeConnectionConfig;
	readonly command?: string;
	readonly spawn?: SubprocessSpawn;
	readonly onMessage?: (message: KernelToHostMessage) => void;
}

export class RubyKernel extends SubprocessKernel {
	static start(options: RubyKernelStartOptions): RubyKernel {
		return new RubyKernel({
			command: options.command ?? "ruby",
			args: [join(import.meta.dirname, "runner.rb")],
			cwd: options.cwd,
			sessionId: options.sessionId,
			connection: options.connection,
			spawn: options.spawn,
			onMessage: options.onMessage,
		});
	}
}
