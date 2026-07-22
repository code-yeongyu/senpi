import { projectCapabilityGaps } from "./projection.mjs";
import {
	initialize,
	isObject,
	request,
	requestResult,
	runAgainstEndpoints,
	startThread,
} from "./scenario.mjs";

export const name = "capability-gaps";
export const expectation = "allowlistedCapabilityDelta";
export const project = projectCapabilityGaps;
export const methods = Object.freeze([
	"remoteControl/client/list",
	"thread/goal/set",
	"account/read",
	"account/rateLimits/read",
	"account/usage/read",
]);

export async function run(endpoints, context) {
	return runAgainstEndpoints(endpoints, async (driver, endpoint) => {
		await initialize(driver);
		const threadId = await startThread(driver, context.cell.workDir);
		await request(driver, "remote-client-list", "remoteControl/client/list", {});
		const goal = await request(driver, "goal-status-subset", "thread/goal/set", {
			threadId,
			objective: "exercise the Codex-only blocked status",
			status: "blocked",
		});
		if (endpoint.target === "codex" && (!isObject(goal) || !Object.hasOwn(goal, "result"))) {
			throw new Error("Codex did not accept the blocked goal status fixture");
		}
		if (endpoint.target === "senpi" && (!isObject(goal) || !isObject(goal.error) || goal.error.code !== -32600)) {
			throw new Error("Senpi did not reject the documented blocked goal status delta");
		}
		await requestResult(driver, "account-read", "account/read", {});
		await request(driver, "account-rate-limits", "account/rateLimits/read", {});
		await request(driver, "account-usage", "account/usage/read", {});
	});
}
