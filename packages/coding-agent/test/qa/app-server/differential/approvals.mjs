import { projectApprovals } from "./projection.mjs";
import {
	initialize,
	isObject,
	runAgainstEndpoints,
	startThread,
	startTurn,
	waitForNotification,
} from "./scenario.mjs";

export const name = "approvals";
export const expectation = "exactParity";
export const project = projectApprovals;
export const methods = Object.freeze(["turn/start"]);
// The fixture is adapted only at the fake-model layer: Codex's shell tool and
// Senpi's bash tool receive the exact same JSON-RPC turn and decision frames.
export const modelTurns = Object.freeze([
	{ toolCalls: [{ name: "exec_command", args: { cmd: "python3 -c 'print(42)'" } }] },
	{ text: "accepted command completed" },
	{ toolCalls: [{ name: "exec_command", args: { cmd: "python3 -c 'print(42)'" } }] },
	{ text: "declined command completed" },
	{ toolCalls: [{ name: "bash", args: { command: "python3 -c 'print(42)'" } }] },
	{ text: "accepted command completed" },
	{ toolCalls: [{ name: "bash", args: { command: "python3 -c 'print(42)'" } }] },
	{ text: "declined command completed" },
]);
export const minModelRequests = 8;
export const codexApprovalPolicy = "untrusted";
export const senpiPermissionPreset = "ask";

export async function run(endpoints, context) {
	return runAgainstEndpoints(endpoints, async (driver) => {
		await initialize(driver);
		const threadId = await startThread(driver, context.cell.workDir, "approval-thread", { approvalPolicy: "untrusted" });
		await completeApprovalTurn(driver, threadId, "approval-accept", "accept");
		await completeApprovalTurn(driver, threadId, "approval-decline", "decline");
	});
}

async function completeApprovalTurn(driver, threadId, id, decision) {
	const turn = await startTurn(driver, id, threadId, `request a ${decision} approval`);
	const approval = await driver.waitForInbound(
		(frame) =>
			isObject(frame) &&
			Object.hasOwn(frame, "id") &&
			frame.method === "item/commandExecution/requestApproval",
		turn.mark,
		120_000,
	);
	const terminal = waitForNotification(driver, "turn/completed", turn.mark, threadId);
	await driver.sendRaw(JSON.stringify({ id: approval.frame.id, result: { decision } }));
	await terminal;
}
