import type { BatchCoordinator } from "./coordinator.ts";
import type { BatchPlan, BatchResult } from "./coordinator-types.ts";

export interface SequentialCoordinator {
	run(plan: BatchPlan): Promise<BatchResult>;
}

export function createSequentialCoordinator(coordinator: BatchCoordinator): SequentialCoordinator {
	return { run: (plan) => coordinator.run(plan) };
}
