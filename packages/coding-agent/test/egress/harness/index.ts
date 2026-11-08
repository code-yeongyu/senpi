/**
 * CK22 hosted harness (senpi#5838): drives the real `AgentSession` / `Agent` / agent loop with the faux provider and
 * installs a hosted `commitStep` on the session's own agent, so conformance cases observe and inject step commits
 * without a stub loop or a stub retry layer.
 */
import {
	type AgentLoopConfig,
	type StepCommit,
	StepCommitError,
	type StepCommitFailure,
	type StepCommitFn,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { createHarness, type Harness, type HarnessOptions } from "../../suite/harness.ts";

export type CommitOutcome = "pending" | "committed" | "rejected";

export interface CommitRecord {
	readonly stepId: string;
	readonly message: AssistantMessage;
	readonly providerToolResults: readonly ToolResultMessage[];
	outcome: CommitOutcome;
	error?: StepCommitError;
}

export interface HeldCommit {
	/** Resolves once the loop is inside this commit. */
	readonly reached: Promise<void>;
	/** Lets the held commit finish as committed. */
	release(): void;
}

export interface CommitInjection {
	nextCommit(kind: "reject", code?: StepCommitFailure): void;
	nextCommit(kind: "hold"): HeldCommit;
}

export interface HostedCounters {
	readonly providerCalls: number;
	readonly events: number;
}

export interface HostedHarness extends Harness {
	readonly commits: readonly CommitRecord[];
	readonly counters: HostedCounters;
	readonly inject: CommitInjection;
}

type PlannedCommit =
	| { readonly kind: "reject"; readonly code: StepCommitFailure }
	| { readonly kind: "hold"; readonly reach: () => void; readonly gate: Promise<void> };

interface LoopConfigOwner {
	createLoopConfig(...args: unknown[]): AgentLoopConfig;
}

export async function createHostedHarness(options: HarnessOptions = {}): Promise<HostedHarness> {
	const base = await createHarness(options);
	const commits: CommitRecord[] = [];
	const planned: PlannedCommit[] = [];

	const commitStep: StepCommitFn = async (step: StepCommit) => {
		const record: CommitRecord = {
			stepId: `step-${commits.length + 1}`,
			message: step.message,
			providerToolResults: step.providerToolResults,
			outcome: "pending",
		};
		commits.push(record);
		const plan = planned.shift();
		if (plan?.kind === "hold") {
			plan.reach();
			await plan.gate;
		}
		if (plan?.kind === "reject") {
			const error = new StepCommitError(record.stepId, plan.code);
			record.outcome = "rejected";
			record.error = error;
			throw error;
		}
		record.outcome = "committed";
	};

	// `createLoopConfig` is the only place the agent assembles its loop config; wrapping it on this instance installs
	// the hosted commit without a source change, and every other field stays exactly what the fused agent builds.
	const owner = base.agent as unknown as LoopConfigOwner;
	const createLoopConfig = owner.createLoopConfig.bind(base.agent);
	owner.createLoopConfig = (...args: unknown[]) => ({ ...createLoopConfig(...args), commitStep });

	function nextCommit(kind: "reject", code?: StepCommitFailure): void;
	function nextCommit(kind: "hold"): HeldCommit;
	function nextCommit(
		kind: "reject" | "hold",
		code: StepCommitFailure = "storage_unavailable",
	): HeldCommit | undefined {
		if (kind === "reject") {
			planned.push({ kind, code });
			return undefined;
		}
		const reached = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		planned.push({ kind, reach: () => reached.resolve(), gate: gate.promise });
		return { reached: reached.promise, release: () => gate.resolve() };
	}

	return {
		...base,
		commits,
		inject: { nextCommit },
		get counters(): HostedCounters {
			return { providerCalls: base.faux.getCallLog().length, events: base.events.length };
		},
	};
}
