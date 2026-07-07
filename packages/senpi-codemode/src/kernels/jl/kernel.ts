import { join } from "node:path";
import type { BridgeConnectionConfig, KernelToHostMessage } from "../../bridge/protocol.ts";
import { SubprocessKernel, type SubprocessSpawn } from "../shared/subprocess-kernel.ts";

export interface JuliaKernelStartOptions {
	readonly cwd: string;
	readonly sessionId: string;
	readonly connection: BridgeConnectionConfig;
	readonly command?: string;
	readonly spawn?: SubprocessSpawn;
	readonly onMessage?: (message: KernelToHostMessage) => void;
}

export class JuliaKernel extends SubprocessKernel {
	static start(options: JuliaKernelStartOptions): JuliaKernel {
		return new JuliaKernel({
			command: options.command ?? "julia",
			// --compile=min/--optimize=0 keep the runner in the interpreter with minimal
			// JIT, which does not change cell results but sharply cuts the process's memory
			// and CPU spike at startup — this makes the kernel far less likely to be
			// OOM/CPU-starved (and killed) on an oversubscribed CI runner.
			args: [
				"--startup-file=no",
				"--history-file=no",
				"--color=no",
				"--compile=min",
				"--optimize=0",
				join(import.meta.dirname, "runner.jl"),
			],
			cwd: options.cwd,
			sessionId: options.sessionId,
			connection: options.connection,
			spawn: options.spawn,
			onMessage: options.onMessage,
		});
	}
}
