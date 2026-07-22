import { projectLifecycle } from "./projection.mjs";
import {
	initialize,
	requestResult,
	runAgainstEndpoints,
	startThread,
	startTurn,
	waitForNotification,
} from "./scenario.mjs";

export const name = "lifecycle";
export const expectation = "exactParity";
export const project = projectLifecycle;
export const modelTurns = Object.freeze([{ text: "materialize lifecycle thread" }, { text: "materialize lifecycle thread" }]);
export const minModelRequests = 2;
export const methods = Object.freeze([
	"thread/start",
	"thread/list",
	"thread/loaded/list",
	"thread/read",
	"thread/name/set",
	"thread/archive",
	"thread/unarchive",
	"thread/resume",
	"thread/fork",
	"thread/unsubscribe",
	"thread/delete",
]);

export async function run(endpoints, context) {
	return runAgainstEndpoints(endpoints, async (driver) => {
		await initialize(driver);
		const threadId = await startThread(driver, context.cell.workDir);
		const materialized = await startTurn(driver, "materialize-thread", threadId, "materialize lifecycle history");
		await waitForNotification(driver, "turn/completed", materialized.mark, threadId);
		await requestResult(driver, "list-active", "thread/list", { archived: false, limit: 20 });
		await requestResult(driver, "loaded-before", "thread/loaded/list", { limit: 20 });
		await requestResult(driver, "thread-read", "thread/read", { threadId });

		const renameMark = driver.mark();
		await requestResult(driver, "thread-name", "thread/name/set", { threadId, name: "differential lifecycle" });
		await waitForNotification(driver, "thread/name/updated", renameMark, threadId);

		const archiveMark = driver.mark();
		await requestResult(driver, "thread-archive", "thread/archive", { threadId });
		await waitForNotification(driver, "thread/archived", archiveMark, threadId);
		await requestResult(driver, "list-archived", "thread/list", { archived: true, limit: 20 });

		const unarchiveMark = driver.mark();
		await requestResult(driver, "thread-unarchive", "thread/unarchive", { threadId });
		await waitForNotification(driver, "thread/unarchived", unarchiveMark, threadId);
		await requestResult(driver, "thread-resume", "thread/resume", { threadId });

		const forkMark = driver.mark();
		const fork = await requestResult(driver, "thread-fork", "thread/fork", { threadId, cwd: context.cell.workDir });
		await waitForNotification(driver, "thread/started", forkMark);
		const forkThreadId = fork.thread?.id;
		if (typeof forkThreadId !== "string" || forkThreadId.length === 0) {
			throw new Error("thread/fork did not return a thread id");
		}
		await requestResult(driver, "unsubscribe", "thread/unsubscribe", { threadId });

		const deleteMark = driver.mark();
		await requestResult(driver, "delete-fork", "thread/delete", { threadId: forkThreadId });
		await waitForNotification(driver, "thread/deleted", deleteMark, forkThreadId);
	});
}
