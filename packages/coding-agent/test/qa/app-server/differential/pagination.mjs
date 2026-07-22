import { projectThreadHistory } from "./projection.mjs";
import {
	assertErrorCode,
	initialize,
	requestError,
	requestResult,
	runAgainstEndpoints,
	startThread,
	startTurn,
	waitForNotification,
} from "./scenario.mjs";

export const name = "pagination";
export const expectation = "allowlistedCapabilityDelta";
export const project = projectThreadHistory;
export const methods = Object.freeze(["thread/turns/list", "thread/items/list"]);
export const modelTurns = Object.freeze([
	{ text: "pagination first" },
	{ text: "pagination second" },
	{ text: "pagination third" },
	{ text: "pagination first" },
	{ text: "pagination second" },
	{ text: "pagination third" },
]);
export const minModelRequests = 6;

export async function run(endpoints, context) {
	return runAgainstEndpoints(endpoints, async (driver) => {
		await initialize(driver);
		const threadId = await startThread(driver, context.cell.workDir, "thread-start", { historyMode: "paginated" });
		for (const index of [1, 2, 3]) {
			const turn = await startTurn(driver, `pagination-seed-${index}`, threadId, `pagination seed ${index}`);
			await waitForNotification(driver, "turn/completed", turn.mark, threadId);
		}
		await requestResult(driver, "turns-forward", "thread/turns/list", { threadId, limit: 2, sortDirection: "desc" });
		await requestResult(driver, "turns-reverse", "thread/turns/list", { threadId, limit: 2, sortDirection: "asc" });
		await requestResult(driver, "items-forward", "thread/items/list", { threadId, limit: 2, sortDirection: "asc" });
		await requestResult(driver, "items-reverse", "thread/items/list", { threadId, limit: 2, sortDirection: "desc" });
		const badTurns = await requestError(driver, "turns-invalid-cursor", "thread/turns/list", {
			threadId,
			cursor: "not-a-cursor",
			limit: 2,
		});
		assertErrorCode(badTurns, -32600, "thread/turns/list invalid cursor");
		const badItems = await requestError(driver, "items-invalid-cursor", "thread/items/list", {
			threadId,
			cursor: "not-a-cursor",
			limit: 2,
		});
		assertErrorCode(badItems, -32600, "thread/items/list invalid cursor");
	});
}
