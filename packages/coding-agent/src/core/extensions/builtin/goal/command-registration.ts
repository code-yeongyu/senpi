import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { parseGoalCommand } from "./command.ts";
import { formatGoalForTool, goalStatusLabel } from "./format.ts";
import { clearGoal, createGoal, readGoal, updateGoal } from "./store.ts";
import type { Goal, GoalAccountingMode, GoalStoreRef } from "./types.ts";

const GOAL_USAGE = "Usage: /goal <objective>";
const GOAL_EMPTY_HINT = "No goal is currently set.";
const REPLACE_GOAL_CHOICE = "Replace current goal";
const CANCEL_REPLACE_GOAL_CHOICE = "Cancel";

export type GoalControlAction = "pause" | "resume" | "clear";

export class GoalControlProtocolError extends Error {
	constructor(message: string) {
		super(`goal control protocol error: ${message}`);
		this.name = "GoalControlProtocolError";
	}
}

export type GoalCommandRegistrationDeps = {
	readonly goalStoreRef: (ctx: ExtensionContext) => GoalStoreRef;
	readonly accountCurrentAgentTurn: (ctx: ExtensionContext, mode: GoalAccountingMode) => Promise<Goal | null>;
	readonly beginAgentGoalAccounting: (goal: Goal) => void;
	readonly stopAgentGoalAccounting: (goalId: string) => void;
	readonly clearAgentGoalAccounting: () => void;
	readonly queueGoalContinuation: (pi: ExtensionAPI, ctx: ExtensionContext, goal: Goal) => void;
	readonly refreshGoalUi: (ctx: ExtensionContext, goal: Goal | null) => void;
};

export function registerGoalControlRpc(
	pi: ExtensionAPI,
	getContext: () => ExtensionContext | undefined,
	deps: GoalCommandRegistrationDeps,
): void {
	pi.rpc.handle("omo.goal.control", async (data) => {
		const action = parseGoalControlAction(data);
		const ctx = getContext();
		if (ctx === undefined) throw new GoalControlProtocolError("session context is unavailable");
		if (action === "clear") {
			await deps.accountCurrentAgentTurn(ctx, "active");
			const cleared = await clearGoal(deps.goalStoreRef(ctx));
			deps.clearAgentGoalAccounting();
			deps.refreshGoalUi(ctx, null);
			return { action, cleared };
		}
		return { action, goal: await applyGoalControl(pi, ctx, action, deps) };
	});
}

export function registerGoalCommand(pi: ExtensionAPI, deps: GoalCommandRegistrationDeps): void {
	pi.registerCommand("goal", {
		description: "Set, inspect, pause, resume, or clear the persistent goal",
		handler: async (rawArgs, ctx) => {
			const command = parseGoalCommand(rawArgs);
			try {
				switch (command.kind) {
					case "show": {
						const goal = await readGoal(deps.goalStoreRef(ctx));
						deps.refreshGoalUi(ctx, goal);
						ctx.ui.notify(
							goal === null ? `${GOAL_USAGE}\n${GOAL_EMPTY_HINT}` : formatGoalForTool(goal),
							goal ? "info" : "warning",
						);
						return;
					}
					case "setObjective": {
						await setGoalObjective(pi, ctx, command.objective, deps);
						return;
					}
					case "setStatus": {
						const goal = await applyGoalControl(pi, ctx, command.status === "active" ? "resume" : "pause", deps);
						if (goal !== null)
							ctx.ui.notify(`Goal ${goalStatusLabel(goal.status)}\n${formatGoalForTool(goal)}`, "info");
						return;
					}
					case "clear": {
						await deps.accountCurrentAgentTurn(ctx, "active");
						const cleared = await clearGoal(deps.goalStoreRef(ctx));
						deps.clearAgentGoalAccounting();
						deps.refreshGoalUi(ctx, null);
						ctx.ui.notify(
							cleared ? "Goal cleared" : "No goal to clear\nThis thread does not currently have a goal.",
							cleared ? "info" : "warning",
						);
						return;
					}
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

async function applyGoalControl(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	action: Exclude<GoalControlAction, "clear">,
	deps: GoalCommandRegistrationDeps,
): Promise<Goal> {
	switch (action) {
		case "pause":
			await deps.accountCurrentAgentTurn(ctx, "active");
			{
				const goal = await updateGoal(deps.goalStoreRef(ctx), { status: "paused" }, "user");
				deps.stopAgentGoalAccounting(goal.id);
				deps.refreshGoalUi(ctx, goal);
				deps.queueGoalContinuation(pi, ctx, goal);
				return goal;
			}
		case "resume": {
			const goal = await updateGoal(deps.goalStoreRef(ctx), { status: "active" }, "user");
			deps.beginAgentGoalAccounting(goal);
			deps.refreshGoalUi(ctx, goal);
			deps.queueGoalContinuation(pi, ctx, goal);
			return goal;
		}
		default:
			return assertNever(action);
	}
}

function parseGoalControlAction(data: unknown): GoalControlAction {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		throw new GoalControlProtocolError("data must be an object with only an action field");
	}
	const keys = Object.keys(data);
	if (keys.length !== 1 || keys[0] !== "action") {
		throw new GoalControlProtocolError("data must contain only the action field");
	}
	const action = Reflect.get(data, "action");
	if (typeof action !== "string" || action.trim().length === 0) {
		throw new GoalControlProtocolError("action must be a non-empty string");
	}
	switch (action) {
		case "pause":
		case "resume":
		case "clear":
			return action;
		default:
			throw new GoalControlProtocolError(`unknown action: ${action}`);
	}
}

function assertNever(value: never): never {
	throw new GoalControlProtocolError(`unhandled action: ${String(value)}`);
}

async function setGoalObjective(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	objective: string,
	deps: GoalCommandRegistrationDeps,
): Promise<void> {
	const ref = deps.goalStoreRef(ctx);
	const current = await readGoal(ref);
	if (current !== null) {
		const shouldReplace = await confirmReplaceGoal(ctx, objective);
		if (!shouldReplace) return;
	}

	if (current?.status === "active") {
		await deps.accountCurrentAgentTurn(ctx, "active");
	}
	const goal = current === null ? await createGoal(ref, objective) : await updateGoal(ref, { objective }, "user");
	if (goal.status === "active") deps.beginAgentGoalAccounting(goal);
	deps.refreshGoalUi(ctx, goal);
	ctx.ui.notify(`Goal ${goalStatusLabel(goal.status)}\n${formatGoalForTool(goal)}`, "info");
	deps.queueGoalContinuation(pi, ctx, goal);
}

async function confirmReplaceGoal(ctx: ExtensionContext, objective: string): Promise<boolean> {
	if (!ctx.hasUI) return true;
	const choice = await ctx.ui.select(`Replace goal?\nNew objective: ${objective}`, [
		REPLACE_GOAL_CHOICE,
		CANCEL_REPLACE_GOAL_CHOICE,
	]);
	return choice === REPLACE_GOAL_CHOICE;
}
