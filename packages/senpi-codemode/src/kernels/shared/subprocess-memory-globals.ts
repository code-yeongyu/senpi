import type { KernelMemoryReport } from "../../bridge/memory-protocol.ts";
import { encodeBridgeFrame, type KernelToHostMessage } from "../../bridge/protocol.ts";
import type { KernelMemoryHost } from "./kernel-memory-host.ts";
import type { KernelResult } from "./subprocess-contract.ts";
import type { SubprocessProcess } from "./subprocess-process.ts";
import type { PendingRun } from "./subprocess-run.ts";

const GLOBALS_TIMEOUT_MS = 5_000;
type GlobalsProcess = Pick<SubprocessProcess, "send"> & {
	readonly child: { readonly pid?: number };
};

interface PendingGlobals {
	readonly process: GlobalsProcess;
	readonly run: PendingRun;
	readonly result: KernelResult;
	readonly report: KernelMemoryReport;
	readonly memory: KernelMemoryHost;
	readonly finish: (result: KernelResult) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

/** Holds FIFO cell ownership until its bounded diagnostic is returned or its deadline expires. */
export class SubprocessMemoryGlobals {
	#pending: PendingGlobals | null = null;
	#available = false;

	reset(available = false): void {
		if (this.#pending !== null) clearTimeout(this.#pending.timer);
		this.#pending = null;
		this.#available = available;
	}

	request(
		owner: {
			readonly process: GlobalsProcess;
			readonly run: PendingRun;
			readonly result: KernelResult;
		},
		memory: KernelMemoryHost,
		finish: (result: KernelResult) => void,
	): void {
		if (this.#pending !== null) return;
		const report = memory.readReport(owner.result, owner.process.child.pid);
		if (!this.#available || report === undefined || !memory.needsGlobals(report)) {
			finish(memory.annotateReport(owner.result, report));
			return;
		}
		const pending: PendingGlobals = {
			...owner,
			report,
			memory,
			finish,
			timer: setTimeout(() => {
				if (this.#pending !== pending) return;
				this.#pending = null;
				pending.finish(memory.annotateReport(pending.result, report));
			}, GLOBALS_TIMEOUT_MS),
		};
		this.#pending = pending;
		owner.process.send(
			encodeBridgeFrame({
				type: "memory-globals",
				cellId: owner.result.cellId,
			}),
		);
	}

	/** Settles an already-finished cell immediately when stop arrives during its optional diagnostic. */
	completeWithoutGlobals(): boolean {
		const pending = this.#pending;
		if (pending === null) return false;
		clearTimeout(pending.timer);
		this.#pending = null;
		pending.finish(pending.memory.annotateReport(pending.result, pending.report));
		return true;
	}

	reply(
		owner: {
			readonly process: GlobalsProcess;
			readonly run: PendingRun | null;
		},
		message: Extract<KernelToHostMessage, { type: "memory-globals-result" }>,
		memory: KernelMemoryHost,
	): void {
		const pending = this.#pending;
		if (
			pending === null ||
			pending.process !== owner.process ||
			pending.run !== owner.run ||
			pending.result.cellId !== message.cellId
		)
			return;
		clearTimeout(pending.timer);
		this.#pending = null;
		const report = message.globals.length === 0 ? pending.report : { ...pending.report, globals: message.globals };
		const result = memory.annotateReport(pending.result, report);
		pending.finish(result);
	}
}
