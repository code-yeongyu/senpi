import type { CliRuntimeConfiguration } from "../../main.ts";

export type HostToLooplessWorker =
	| { type: "start"; configuration: CliRuntimeConfiguration; cwd: string }
	| { type: "close" };

export type LooplessWorkerToHost = { type: "ready"; tools: readonly string[] } | { type: "failure"; error: string };
