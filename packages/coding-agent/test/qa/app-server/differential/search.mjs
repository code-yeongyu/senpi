import { projectSearch } from "./projection.mjs";
import {
	arrayField,
	initialize,
	objectField,
	requestResult,
	runAgainstEndpoints,
	startThread,
	startTurn,
	stringField,
	waitForNotification,
} from "./scenario.mjs";

export const name = "search";
export const expectation = "structuralParity";
export const project = projectSearch;
export const methods = Object.freeze(["thread/search", "thread/searchOccurrences"]);
export const modelTurns = Object.freeze([
	{ text: "assistant needle alpha" },
	{ text: "assistant needle beta" },
	{ text: "assistant needle gamma" },
	{ text: "assistant needle alpha" },
	{ text: "assistant needle beta" },
	{ text: "assistant needle gamma" },
]);
export const minModelRequests = 6;

export async function run(endpoints, context) {
	return runAgainstEndpoints(endpoints, async (driver) => {
		await initialize(driver);
		const threadId = await startThread(driver, context.cell.workDir, "thread-start", { historyMode: "paginated" });
		const denseNeedles = `😀 ${Array.from({ length: 300 }, () => "needle").join(" ")}`;
		for (const [index, text] of [denseNeedles, "seed needle beta", "seed needle gamma"].entries()) {
			const turn = await startTurn(driver, `search-turn-${index + 1}`, threadId, text);
			await waitForNotification(driver, "turn/completed", turn.mark, threadId);
		}
		await requestResult(driver, "thread-search", "thread/search", {
			searchTerm: "needle",
			limit: 20,
		});
		const occurrences = await requestResult(driver, "search-occurrences", "thread/searchOccurrences", {
			threadId,
			searchTerm: "needle",
			limit: 999,
		});
		const data = arrayField(occurrences, "data");
		if (data.length !== 250) throw new Error(`${driver.target} did not clamp thread/searchOccurrences to 250 results`);
		const first = objectField(data[0]);
		const snippet = stringField(first, "snippet");
		const range = objectField(first, "snippetMatchRange");
		const start = numericField(range, "start");
		const end = numericField(range, "end");
		if (snippet.slice(start, end).toLowerCase() !== "needle") {
			throw new Error(`${driver.target} did not return a UTF-16 snippetMatchRange`);
		}
		const turnId = stringField(first, "turnId");
		const history = await requestResult(driver, "turn-cursor", "thread/turns/list", {
			threadId,
			cursor: stringField(first, "turnCursor"),
			itemsView: "full",
		});
		if (!arrayField(history, "data").some((turn) => objectField(turn).id === turnId)) {
			throw new Error(`${driver.target} turnCursor did not hydrate its matching turn`);
		}
	});
}

function numericField(value, key) {
	if (!Object.hasOwn(value, key) || typeof value[key] !== "number") {
		throw new Error(`Expected numeric field ${key}`);
	}
	return value[key];
}
