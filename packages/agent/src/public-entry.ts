import { Agent as LoopAgent, type AgentOptions } from "./agent.ts";
import {
	agentLoop as loopAgentLoop,
	agentLoopContinue as loopAgentLoopContinue,
	runAgentLoop as loopRunAgentLoop,
	runAgentLoopContinue as loopRunAgentLoopContinue,
} from "./agent-loop.ts";
import { openMemoryBatchStore } from "./execution/prepared/memory-batch-store.ts";
import type { AgentLoopConfig } from "./types.ts";

// The package entry's loop and Agent: the loop core builds no store (senpi#4996), so the entry supplies a fresh in-memory
// store per batch unless the caller passes its own factory or ToolHost. External callers need no new argument.
function withBatchStore<T extends Pick<AgentLoopConfig, "batchStoreFactory">>(config: T): T {
	return config.batchStoreFactory === undefined ? { ...config, batchStoreFactory: openMemoryBatchStore } : config;
}

export class Agent extends LoopAgent {
	constructor(options: AgentOptions) {
		super(withBatchStore(options));
	}
}

export const agentLoop: typeof loopAgentLoop = (prompts, context, config, signal, streamFn) =>
	loopAgentLoop(prompts, context, withBatchStore(config), signal, streamFn);

export const agentLoopContinue: typeof loopAgentLoopContinue = (context, config, signal, streamFn) =>
	loopAgentLoopContinue(context, withBatchStore(config), signal, streamFn);

export const runAgentLoop: typeof loopRunAgentLoop = (prompts, context, config, emit, signal, streamFn) =>
	loopRunAgentLoop(prompts, context, withBatchStore(config), emit, signal, streamFn);

export const runAgentLoopContinue: typeof loopRunAgentLoopContinue = (context, config, emit, signal, streamFn) =>
	loopRunAgentLoopContinue(context, withBatchStore(config), emit, signal, streamFn);
