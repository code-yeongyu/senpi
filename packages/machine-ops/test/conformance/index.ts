import { defineFileCases } from "./files.ts";
import type { ConformanceRunner, ConformanceTarget } from "./harness.ts";
import { defineInfoCases } from "./info.ts";
import { defineProcessCases } from "./process.ts";

export type { ConformanceRunner, ConformanceTarget, Fixture } from "./harness.ts";

/**
 * The MachineOps contract as one suite: every implementation (the local one, a remote executor's) registers it
 * with its runner's `describe`/`it` and passes when it behaves like `createLocalMachineOps`.
 */
export function defineMachineOpsConformance(runner: ConformanceRunner, target: ConformanceTarget): void {
	runner.describe("MachineOps conformance", () => {
		defineFileCases(runner, target);
		defineProcessCases(runner, target);
		defineInfoCases(runner, target);
	});
}
