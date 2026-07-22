import { projectTurnLifecycle } from "./projection.mjs";
import {
	initialize,
	requestResult,
	runAgainstEndpoints,
	startThread,
	startTurn,
	waitForNotification,
} from "./scenario.mjs";

export const name = "turns";
export const expectation = "exactParity";
export const project = projectTurnLifecycle;
export const methods = Object.freeze(["turn/start", "turn/steer", "turn/interrupt"]);
export const modelTurns = Object.freeze([
	{ text: "streaming differential response", chunks: 24, chunkDelayMs: 10 },
	{ text: "interrupted differential response", chunks: 24, chunkDelayMs: 10 },
	{ text: "streaming differential response", chunks: 24, chunkDelayMs: 10 },
	{ text: "interrupted differential response", chunks: 24, chunkDelayMs: 10 },
]);
export const minModelRequests = 4;

export async function run(endpoints, context) {
	return runAgainstEndpoints(endpoints, async (driver) => {
		await initialize(driver);
		const threadId = await startThread(driver, context.cell.workDir);

		const first = await startTurn(driver, "turn-start-steer", threadId, "stream then accept a steering message");
		const firstTerminal = waitForNotification(driver, "turn/completed", first.mark, threadId);
		await requestResult(driver, "turn-steer", "turn/steer", {
			threadId,
			expectedTurnId: first.turnId,
			input: [{ type: "text", text: "steer the active differential turn" }],
		});
		await firstTerminal;

		const second = await startTurn(driver, "turn-start-interrupt", threadId, "stream until the deterministic interrupt");
		const secondTerminal = waitForNotification(driver, "turn/completed", second.mark, threadId);
		await requestResult(driver, "turn-interrupt", "turn/interrupt", { threadId, turnId: second.turnId });
		await secondTerminal;
	});
}
