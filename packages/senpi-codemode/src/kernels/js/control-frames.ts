import type { KernelToHostMessage } from "../../bridge/protocol.ts";
import { CHILD_LIFECYCLE_OP, INTERRUPT_ACK_OP } from "../../bridge/reserved.ts";
import type { JavaScriptKernelMemory } from "./kernel-memory.ts";
import type { JavaScriptRunQueue } from "./run-queue.ts";
import type { WorkerChildren } from "./worker-children.ts";

export interface ControlFrameOwners {
	readonly memory: Pick<JavaScriptKernelMemory, "consume">;
	readonly runs: Pick<JavaScriptRunQueue, "acknowledgeInterrupt">;
	readonly children: Pick<WorkerChildren, "track">;
}

/** Routes a worker's side-channel frames (memory readings, interrupt acks, child lifecycle) to their owners. */
export function consumeControlFrame(message: KernelToHostMessage, owners: ControlFrameOwners): boolean {
	if (owners.memory.consume(message)) return true;
	if (message.type !== "status") return false;
	if (message.event.op === INTERRUPT_ACK_OP) {
		owners.runs.acknowledgeInterrupt(message.event);
		return true;
	}
	if (message.event.op !== CHILD_LIFECYCLE_OP) return false;
	owners.children.track(message.event);
	return true;
}
