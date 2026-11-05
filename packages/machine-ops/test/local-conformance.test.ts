import { describe, it } from "vitest";
import { createLocalMachineOps } from "../src/local.ts";
import { createInProcessHolderLink } from "../src/process/in-process-holder.ts";
import type { MachineOps } from "../src/types.ts";
import { defineMachineOpsConformance } from "./conformance/index.ts";

const holders = new WeakMap<MachineOps, ReturnType<typeof createInProcessHolderLink>>();

defineMachineOpsConformance(
	{ describe, it: (name, fn, timeoutMs) => it(name, fn, timeoutMs) },
	{
		create(stateDir) {
			const holder = createInProcessHolderLink();
			const ops = createLocalMachineOps({ stateDir, holder });
			holders.set(ops, holder);
			return ops;
		},
		async dispose(ops) {
			await holders.get(ops)?.close();
		},
	},
);
