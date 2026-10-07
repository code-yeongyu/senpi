import type { HostToKernelMessage, KernelToHostMessage } from "../../bridge/protocol.ts";
import { restartNotice } from "../shared/kernel-death.ts";
import type { ResultMessage } from "./kernel-contract.ts";
import { type JavaScriptMemoryReading, KernelMemoryBridge } from "./kernel-memory-bridge.ts";
import type { JavaScriptKernelOptions } from "./local-module-loader.ts";
import { JavaScriptProcessMemoryHost } from "./process-memory-host.ts";

/**
 * The kernel's one view of memory: the worker's heap bridge, or in process mode the child process's footprint, plus
 * the restart notice a crash leaves for the next result.
 */
export class JavaScriptKernelMemory {
	readonly #bridge: KernelMemoryBridge;
	readonly #process: JavaScriptProcessMemoryHost | null;
	readonly #pid: () => number | undefined;
	readonly #processMode: boolean;
	#restartNotice: string | null = null;

	constructor(options: JavaScriptKernelOptions, pid: () => number | undefined) {
		const processMode = options.isolation === "process";
		this.#bridge = new KernelMemoryBridge(processMode ? undefined : options.memory, options.onMemoryCollected);
		this.#process =
			processMode && options.processMemory !== undefined
				? new JavaScriptProcessMemoryHost(options.processMemory.thresholds, options.processMemory.readFootprint)
				: null;
		this.#pid = pid;
		this.#processMode = processMode;
	}

	get lastLiveBytes(): number | undefined {
		return this.#process === null ? this.#bridge.lastLiveBytes : this.#process.lastLiveBytes(this.#pid);
	}

	/** A reading between cells. The worker is asked only through `post`, given when a worker is ready to answer. */
	async query(
		post: ((message: HostToKernelMessage) => void) | undefined,
	): Promise<JavaScriptMemoryReading | undefined> {
		if (this.#process !== null) return this.#process.query(this.#pid);
		return post === undefined ? undefined : await this.#bridge.query(post);
	}

	consume(message: KernelToHostMessage): boolean {
		return this.#bridge.consume(message);
	}

	settled(message: ResultMessage): ResultMessage {
		if (this.#process !== null) return this.#process.settled(message, this.#pid);
		const settled = this.#bridge.settled(message);
		if (this.#restartNotice === null) return settled;
		const notice = this.#restartNotice;
		this.#restartNotice = null;
		return { ...settled, notice, kernelState: "restarted" };
	}

	/** Whether the kernel should restart for memory now; only once nothing is running or queued (`idle`). */
	claimRecycle(idle: boolean): boolean {
		const worker = this.#bridge.claimRecycle(idle);
		return this.#process?.claimRecycle(idle) === true || worker;
	}

	/** The worker was retired: pending readings fail. */
	workerLost(error: Error): void {
		this.#bridge.workerLost(error);
	}

	/**
	 * The kernel crashed: pending readings fail. In process mode the next result also says the kernel restarted (a
	 * crashed child loses every global); worker mode reports its crash as it always has, with no notice.
	 */
	crashed(error: Error): void {
		this.#bridge.workerLost(error);
		if (this.#process !== null) {
			this.#process.workerLost();
			this.#process.markRestarted(error);
			return;
		}
		if (this.#processMode) this.#restartNotice = restartNotice("js", error.message);
	}
}
