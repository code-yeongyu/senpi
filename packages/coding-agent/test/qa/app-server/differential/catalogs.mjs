import { projectCatalogs } from "./projection.mjs";
import {
	initialize,
	requestResult,
	runAgainstEndpoints,
	startThread,
} from "./scenario.mjs";

export const name = "catalogs";
export const expectation = "structuralParity";
export const project = projectCatalogs;
export const methods = Object.freeze([
	"model/list",
	"skills/list",
	"mcpServerStatus/list",
	"config/read",
	"configRequirements/read",
	"experimentalFeature/list",
	"permissionProfile/list",
	"remoteControl/status/read",
	"collaborationMode/list",
	"thread/metadata/update",
	"thread/settings/update",
	"thread/goal/get",
	"thread/goal/clear",
]);

export async function run(endpoints, context) {
	return runAgainstEndpoints(endpoints, async (driver) => {
		await initialize(driver);
		const threadId = await startThread(driver, context.cell.workDir);
		await requestResult(driver, "model-list", "model/list", { limit: 20 });
		await requestResult(driver, "skills-list", "skills/list", { cwd: context.cell.workDir });
		await requestResult(driver, "mcp-status", "mcpServerStatus/list", { threadId, detail: "full", limit: 20 });
		await requestResult(driver, "config-read", "config/read", { cwd: context.cell.workDir, includeLayers: true });
		await requestResult(driver, "config-requirements", "configRequirements/read", {});
		await requestResult(driver, "experimental-features", "experimentalFeature/list", { threadId, limit: 20 });
		await requestResult(driver, "permission-profiles", "permissionProfile/list", { cwd: context.cell.workDir, limit: 20 });
		await requestResult(driver, "remote-status", "remoteControl/status/read", {});
		await requestResult(driver, "collaboration-modes", "collaborationMode/list", {});
		await requestResult(driver, "metadata-update", "thread/metadata/update", {
			threadId,
			gitInfo: { sha: "0123456789abcdef", branch: "differential", originUrl: "https://example.test/parity.git" },
		});
		await requestResult(driver, "settings-update", "thread/settings/update", { threadId, model: "mock-model" });
		await requestResult(driver, "goal-get", "thread/goal/get", { threadId });
		await requestResult(driver, "goal-clear", "thread/goal/clear", { threadId });
	});
}
