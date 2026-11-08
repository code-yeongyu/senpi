/**
 * CK22 reference hosted session driver (custody design 15.1, 15.2). It runs the real `AgentSession` / `Agent` /
 * agent loop with the faux provider and holds the hosted invariants CK1s asserts against:
 * - the commit latches and bumps the instance generation synchronously, before its promise rejects;
 * - every provider call needs an admission for the current generation (refused otherwise, zero dials);
 * - durable history rows come only from admitted input and committed steps, never from the session's own writes;
 * - events are stamped with their instance generation and only the current generation is forwarded;
 * - a rejected commit rebuilds a fresh instance from the durable rows.
 * The commit hook is installed on the test agent instance (`createLoopConfig`) until the CK1p seam exists (C.P3).
 */
import {
	type AgentLoopConfig,
	type AgentMessage,
	isStepCommitError,
	type StepCommit,
	StepCommitError,
	type StepCommitFailure,
	type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { AgentSession, AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { createHarness, type Harness, type HarnessOptions } from "../../suite/harness.ts";

export type HistoryRow =
	| { readonly kind: "input"; readonly message: AgentMessage }
	| { readonly kind: "step"; readonly stepId: string; readonly message: AgentMessage };

export interface LatchRecord {
	readonly stepId: string;
	readonly code: StepCommitFailure;
	readonly generationAfter: number;
	readonly forwardedBefore: number;
}

export interface ForwardedEvent {
	readonly generation: number;
	readonly event: AgentSessionEvent;
}

export interface DriverCounters {
	readonly admissions: number;
	readonly refusals: number;
	readonly providerCalls: number;
	readonly events: number;
}

export interface ReferenceDriver {
	readonly session: AgentSession;
	readonly generation: number;
	readonly rows: readonly HistoryRow[];
	readonly forwarded: readonly ForwardedEvent[];
	readonly latchHistory: readonly LatchRecord[];
	readonly counters: DriverCounters;
	readonly rebuilds: number;
	readonly inject: { nextCommit(kind: "reject", code?: StepCommitFailure): void };
	setResponses: Harness["setResponses"];
	appendResponses: Harness["appendResponses"];
	prompt(text: string): Promise<void>;
	cleanup(): void;
}

export function projectHistoryRows(rows: readonly HistoryRow[]): AgentMessage[] {
	return rows.map((row) => row.message);
}

interface LoopConfigOwner {
	createLoopConfig(...args: unknown[]): AgentLoopConfig;
}

export async function createReferenceDriver(options: HarnessOptions = {}): Promise<ReferenceDriver> {
	const rows: HistoryRow[] = [];
	const forwarded: ForwardedEvent[] = [];
	const latchHistory: LatchRecord[] = [];
	const plannedRejections: StepCommitFailure[] = [];
	const instances: Harness[] = [];
	let generation = 1;
	let admissions = 0;
	let refusals = 0;
	let steps = 0;
	let rebuilds = 0;

	const first = await createHarness(options);
	let current = first;

	function install(harness: Harness, instanceGeneration: number): void {
		instances.push(harness);
		const owner = harness.agent as unknown as LoopConfigOwner;
		const createLoopConfig = owner.createLoopConfig.bind(harness.agent);
		const commitStep = async (step: StepCommit): Promise<void> => {
			if (instanceGeneration !== generation) {
				refusals += 1;
				throw new StepCommitError(`stale-${instanceGeneration}`, "generation");
			}
			steps += 1;
			const stepId = `step-${steps}`;
			const code = plannedRejections.shift();
			if (code !== undefined) {
				// Latch before the promise rejects: anything the session runs on its way out sees the new generation.
				generation += 1;
				latchHistory.push({ stepId, code, generationAfter: generation, forwardedBefore: forwarded.length });
				throw new StepCommitError(stepId, code);
			}
			rows.push({ kind: "step", stepId, message: step.message });
			for (const result of step.providerToolResults) rows.push({ kind: "step", stepId, message: result });
		};
		owner.createLoopConfig = (...args: unknown[]) => ({ ...createLoopConfig(...args), commitStep });

		const dial: StreamFn = harness.agent.streamFunction;
		harness.agent.streamFunction = (model, context, streamOptions) => {
			if (instanceGeneration !== generation) {
				refusals += 1;
				throw new StepCommitError(`stale-${instanceGeneration}`, "generation");
			}
			admissions += 1;
			return dial(model, context, streamOptions);
		};

		harness.session.subscribe((event) => {
			if (instanceGeneration !== generation) return;
			forwarded.push({ generation: instanceGeneration, event });
			if (event.type === "message_end" && event.message.role === "user") {
				rows.push({ kind: "input", message: event.message });
			}
		});
	}

	async function rebuild(): Promise<void> {
		const next = await createHarness({ ...options, siblingOf: first });
		next.agent.state.messages = projectHistoryRows(rows);
		install(next, generation);
		current = next;
		rebuilds += 1;
	}

	install(first, generation);

	return {
		get session() {
			return current.session;
		},
		get generation() {
			return generation;
		},
		rows,
		forwarded,
		latchHistory,
		get counters(): DriverCounters {
			return { admissions, refusals, providerCalls: first.faux.getCallLog().length, events: forwarded.length };
		},
		get rebuilds() {
			return rebuilds;
		},
		inject: {
			nextCommit(_kind: "reject", code: StepCommitFailure = "storage_unavailable") {
				plannedRejections.push(code);
			},
		},
		setResponses: first.setResponses,
		appendResponses: first.appendResponses,
		async prompt(text: string) {
			const latchesBefore = latchHistory.length;
			try {
				await current.session.prompt(text);
			} catch (error) {
				if (!isStepCommitError(error)) throw error;
			}
			// Under decision C the old instance synthesizes its failure and `prompt` may resolve, so the rebuild keys on
			// the latch, not on the rejection.
			if (latchHistory.length > latchesBefore) await rebuild();
		},
		cleanup() {
			for (const instance of instances.reverse()) instance.cleanup();
		},
	};
}
