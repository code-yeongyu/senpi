import { readProcessFootprint } from "@code-yeongyu/senpi";
import type { KernelMemoryThresholds } from "../bridge/memory-protocol.ts";
import type { BridgeConnectionConfig, KernelToHostMessage } from "../bridge/protocol.ts";
import { JuliaKernel } from "../kernels/jl/kernel.ts";
import type { JavaScriptKernel } from "../kernels/js/context-manager.ts";
import { PythonKernel } from "../kernels/py/kernel.ts";
import type { PeerKernelToolsDescribe } from "../kernels/py/kernel-tools-host.ts";
import { defaultSpawn } from "../kernels/py/process.ts";
import { RubyKernel } from "../kernels/rb/kernel.ts";
import type { SessionEnvironment } from "../kernels/session-env.ts";
import { spawnSubprocess } from "../kernels/shared/subprocess-process.ts";
import type { EvalKernel, EvalLanguage } from "../tool/types.ts";
import { type KernelMemoryReading, kernelRegistry, type RegisteredKernelSource } from "./kernel-registry.ts";

export interface StartedKernel {
	readonly kernel: EvalKernel;
	readonly memory: RegisteredKernelSource;
}

export interface SubprocessKernelStart {
	readonly language: Exclude<EvalLanguage, "js">;
	readonly interpreterPath: string;
	readonly memory: KernelMemoryThresholds;
	readonly shared: {
		readonly sessionId: string;
		readonly cwd: string;
		readonly sessionEnv?: SessionEnvironment;
		readonly connection: BridgeConnectionConfig;
		readonly onMessage: (message: KernelToHostMessage) => void;
	};
	readonly peerKernelToolsDescribe?: PeerKernelToolsDescribe;
}

export function registerKernel(sessionId: string, language: EvalLanguage, memory: RegisteredKernelSource): string {
	const id = crypto.randomUUID();
	kernelRegistry.register({ id, sessionId, language, source: memory });
	return id;
}

/** One registry entry per language for a session; replacing a language's kernel replaces its entry. */
export class SessionKernelRegistrations {
	readonly #owner: string;
	readonly #ids = new Map<EvalLanguage, string>();

	constructor(owner: string) {
		this.#owner = owner;
	}

	register(language: EvalLanguage, memory: RegisteredKernelSource | undefined): void {
		this.unregister(language);
		if (memory !== undefined) this.#ids.set(language, registerKernel(this.#owner, language, memory));
	}

	unregister(language: EvalLanguage): void {
		const id = this.#ids.get(language);
		if (id !== undefined) kernelRegistry.unregister(id);
		this.#ids.delete(language);
	}

	clear(): void {
		for (const language of [...this.#ids.keys()]) this.unregister(language);
	}
}

export function javaScriptKernelMemory(kernel: JavaScriptKernel): RegisteredKernelSource {
	const measure = kernel.mode === "process" ? "footprint" : "heap";
	return {
		measure,
		lastLiveBytes: () => kernel.lastLiveBytes,
		busy: () => kernel.queueSnapshot().activeCellId !== null,
		queryMemory: async () => {
			const reading = await kernel.queryMemory();
			return reading === undefined ? undefined : { liveBytes: reading.liveBytes, measure: reading.measure };
		},
		...(measure === "footprint" ? { pid: () => kernel.processPid } : {}),
	};
}

/**
 * Starts a py/rb/jl kernel through a spawn that remembers its interpreter's pid, so the registry can read
 * that process's footprint on demand; a restarted interpreter replaces the pid.
 */
export async function startSubprocessKernel(start: SubprocessKernelStart): Promise<StartedKernel> {
	let pid: number | undefined;
	const { shared, memory } = start;
	let kernel: EvalKernel;
	if (start.language === "py") {
		kernel = await PythonKernel.start({
			...shared,
			interpreterPath: start.interpreterPath,
			memory,
			...(start.peerKernelToolsDescribe === undefined
				? {}
				: { peerKernelToolsDescribe: start.peerKernelToolsDescribe }),
			spawnProcess: (options) => {
				const child = defaultSpawn(options);
				pid = child.pid;
				return child;
			},
		});
	} else {
		// rb/jl runners report no memory: the host reads the interpreter footprint for the ceiling only.
		const options = {
			...shared,
			command: start.interpreterPath,
			memory: { thresholds: memory, readFootprint: readProcessFootprint },
			spawn: (command: string, args: readonly string[], spawnOptions: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
				const child = spawnSubprocess(undefined, { command, args, ...spawnOptions });
				pid = child.pid;
				return child;
			},
		};
		kernel = start.language === "rb" ? RubyKernel.start(options) : JuliaKernel.start(options);
	}
	return { kernel, memory: footprintMemory(kernel, () => pid) };
}

function footprintMemory(kernel: EvalKernel, pid: () => number | undefined): RegisteredKernelSource {
	const read = (): KernelMemoryReading | undefined => {
		const current = pid();
		const footprint = current === undefined ? undefined : readProcessFootprint(current);
		return footprint === undefined ? undefined : { liveBytes: Math.round(footprint.bytes), measure: "footprint" };
	};
	return {
		measure: "footprint",
		lastLiveBytes: () => read()?.liveBytes,
		busy: () => kernel.queueSnapshot().activeCellId !== null,
		queryMemory: async () => read(),
		pid,
	};
}
