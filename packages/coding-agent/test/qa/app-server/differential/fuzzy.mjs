import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectFuzzy } from "./projection.mjs";
import {
	arrayField,
	initialize,
	requestResult,
	runAgainstEndpoints,
	waitForNotification,
} from "./scenario.mjs";

export const name = "fuzzy";
export const expectation = "structuralParity";
export const project = projectFuzzy;
export const methods = Object.freeze([
	"fuzzyFileSearch",
	"fuzzyFileSearch/sessionStart",
	"fuzzyFileSearch/sessionUpdate",
	"fuzzyFileSearch/sessionStop",
]);

export async function run(endpoints, context) {
	seedFiles(context.cell.workDir);
	return runAgainstEndpoints(endpoints, async (driver) => {
		await initialize(driver);
		const oneShot = await requestResult(driver, "fuzzy-one-shot", "fuzzyFileSearch", {
			query: "needle",
			roots: [context.cell.workDir],
			cancellationToken: "differential-fuzzy",
		});
		if (arrayField(oneShot, "files").length === 0) throw new Error("fuzzyFileSearch did not find the seeded fixture");
		await requestResult(driver, "fuzzy-session-start", "fuzzyFileSearch/sessionStart", {
			sessionId: "differential-fuzzy-session",
			roots: [context.cell.workDir],
		});
		const updateMark = driver.mark();
		const updated = waitForNotification(driver, "fuzzyFileSearch/sessionUpdated", updateMark);
		const completed = waitForNotification(driver, "fuzzyFileSearch/sessionCompleted", updateMark);
		await requestResult(driver, "fuzzy-session-update", "fuzzyFileSearch/sessionUpdate", {
			sessionId: "differential-fuzzy-session",
			query: "needle",
		});
		await Promise.all([updated, completed]);
		await requestResult(driver, "fuzzy-session-stop", "fuzzyFileSearch/sessionStop", {
			sessionId: "differential-fuzzy-session",
		});
	});
}

function seedFiles(root) {
	mkdirSync(join(root, "needle-fixtures"), { recursive: true });
	writeFileSync(join(root, "needle-fixtures", "needle-result.txt"), "differential fuzzy fixture\n");
	writeFileSync(join(root, "needle-fixtures", "unrelated.txt"), "no match\n");
}
