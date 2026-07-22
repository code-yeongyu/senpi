import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createHarnessForRoot,
	FakeConnection,
	objectAt,
	responseResult,
	threadIdFromResponse,
} from "../../suite/app-server-thread-handlers-harness.ts";

type DeferredAction = () => Promise<void> | void;

async function main(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "senpi-task14-goal-"));
	try {
		const deferredActions: DeferredAction[] = [];
		const harness = createHarnessForRoot(root, {
			deferUntilResponded: (_connectionId, action) => {
				deferredActions.push(action);
				return true;
			},
		});
		const other = new FakeConnection("conn-2");
		harness.notifications.addConnection(other);
		const threadId = threadIdFromResponse(
			await harness.registry.dispatch(harness.connection, {
				id: 1,
				method: "thread/start",
				params: { cwd: root },
			}),
		);
		harness.connection.received.length = 0;
		other.received.length = 0;
		deferredActions.length = 0;

		const created = await harness.registry.dispatch(harness.connection, {
			id: 2,
			method: "thread/goal/set",
			params: { threadId, objective: "Run the goal QA", tokenBudget: 2048 },
		});
		const createdGoal = objectAt(responseResult(created), "goal");
		const roundTrip =
			createdGoal.threadId === threadId &&
			createdGoal.objective === "Run the goal QA" &&
			createdGoal.status === "active" &&
			createdGoal.tokenBudget === 2048
				? 1
				: 0;
		const noNotificationBeforeResponse =
			harness.connection.received.length === 0 && other.received.length === 0 ? 1 : 0;
		const deferred = deferredActions.shift();
		if (!deferred) throw new Error("goal update did not defer its notification");
		await deferred();
		const globalUpdate = harness.connection.received.length === 1 && other.received.length === 1 ? 1 : 0;

		const preserved = await harness.registry.dispatch(harness.connection, {
			id: 3,
			method: "thread/goal/set",
			params: { threadId, status: "paused" },
		});
		const preservedGoal = objectAt(responseResult(preserved), "goal");
		const omittedKeepsBudget = preservedGoal.tokenBudget === 2048 ? 1 : 0;
		const preservedDeferred = deferredActions.shift();
		if (!preservedDeferred) throw new Error("preserved goal update did not defer its notification");
		await preservedDeferred();

		const clearedBudget = await harness.registry.dispatch(harness.connection, {
			id: 4,
			method: "thread/goal/set",
			params: { threadId, tokenBudget: null },
		});
		const clearedBudgetGoal = objectAt(responseResult(clearedBudget), "goal");
		const nullClearsBudget = clearedBudgetGoal.tokenBudget === null ? 1 : 0;
		const budgetDeferred = deferredActions.shift();
		if (!budgetDeferred) throw new Error("cleared goal budget update did not defer its notification");
		await budgetDeferred();

		const firstClear = await harness.registry.dispatch(harness.connection, {
			id: 5,
			method: "thread/goal/clear",
			params: { threadId },
		});
		const firstClearAction = deferredActions.shift();
		if (!firstClearAction) throw new Error("existing goal clear did not defer its notification");
		await firstClearAction();
		const secondClear = await harness.registry.dispatch(harness.connection, {
			id: 6,
			method: "thread/goal/clear",
			params: { threadId },
		});
		const firstClearResult = responseResult(firstClear);
		const secondClearResult = responseResult(secondClear);
		const conditionalClear =
			firstClearResult.cleared === true && secondClearResult.cleared === false && deferredActions.length === 0
				? 1
				: 0;

		console.log(`GOAL_ROUNDTRIP=${roundTrip && globalUpdate && noNotificationBeforeResponse}`);
		console.log(`BUDGET_TRISTATE=${omittedKeepsBudget && nullClearsBudget}`);
		console.log(`CLEARED_NOTIF_CONDITIONAL=${conditionalClear}`);
		if (
			roundTrip !== 1 ||
			globalUpdate !== 1 ||
			noNotificationBeforeResponse !== 1 ||
			omittedKeepsBudget !== 1 ||
			nullClearsBudget !== 1 ||
			conditionalClear !== 1
		) {
			throw new Error("task14 goal assertions failed");
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

main()
	.then(() => process.exit(0))
	.catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
