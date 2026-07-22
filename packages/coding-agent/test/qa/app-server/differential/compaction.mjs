import { projectCompaction } from "./projection.mjs";
import {
	initialize,
	requestResult,
	runAgainstEndpoints,
	startThread,
	startTurn,
	waitForNotification,
} from "./scenario.mjs";

export const name = "compaction";
export const expectation = "exactParity";
export const project = projectCompaction;
export const methods = Object.freeze(["thread/compact/start"]);
export const modelTurns = Object.freeze([
	{ text: "seed context for compaction" },
	{ text: "deterministic compaction summary" },
	{ text: "seed context for compaction" },
	{ text: "deterministic compaction summary" },
]);
export const minModelRequests = 2;

export async function run(endpoints, context) {
	return runAgainstEndpoints(endpoints, async (driver) => {
		await initialize(driver);
		const threadId = await startThread(driver, context.cell.workDir);
		const seed = await startTurn(driver, "seed-turn", threadId, "seed enough context for the compaction fixture");
		await waitForNotification(driver, "turn/completed", seed.mark, threadId);

		const compactMark = driver.mark();
		const started = waitForNotification(driver, "item/started", compactMark, threadId);
		await requestResult(driver, "compact-start", "thread/compact/start", { threadId });
		await started;
	});
}
