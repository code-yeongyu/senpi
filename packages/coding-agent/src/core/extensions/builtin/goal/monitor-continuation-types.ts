import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentEndEvent, ExtensionContext } from "../../types.ts";
import type { GoalContinuationVerdict } from "./continuation.ts";
import type { Goal } from "./types.ts";
import type { GoalWaitKind } from "./wait-progress.ts";

export interface AgentEndOptions {
	readonly ctx: ExtensionContext;
	readonly goal: Goal | null;
	readonly messages: readonly AgentMessage[];
}

export interface SystemAbortOptions extends AgentEndOptions {
	readonly event: AgentEndEvent;
	readonly willRetry: boolean;
}

export type ContinuingGoalContinuationVerdict = Extract<GoalContinuationVerdict, { kind: "continue" }>;
export type DelayedContinuationKind = GoalWaitKind;
export type ResumptionChannelCounts = Readonly<Record<string, number>>;

export type GoalContinuationAdmission = {
	readonly goal: Goal;
	readonly admitted: boolean;
};
