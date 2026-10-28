import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness } from "../../suite/harness.ts";
import {
	childTools,
	KILL_BARRIER_LINE_PREFIX,
	KILL_BARRIER_SCENARIOS,
	type KillBarrierReport,
	type KillBarrierScenarioName,
} from "./kill-barrier.ts";

function isScenarioName(value: string | undefined): value is KillBarrierScenarioName {
	return value !== undefined && Object.hasOwn(KILL_BARRIER_SCENARIOS, value);
}

const [scenarioName, root] = process.argv.slice(2);
if (!isScenarioName(scenarioName) || root === undefined) {
	throw new Error("usage: kill-barrier-child.ts <scenario> <root>");
}
const scenario = KILL_BARRIER_SCENARIOS[scenarioName];
const sessionManager = SessionManager.create(root, join(root, "sessions"));

function report(toolCallId: string): void {
	const sessionFile = sessionManager.getSessionFile();
	if (sessionFile === undefined) throw new Error("kill-barrier child has no session file");
	const callIsRecorded = sessionManager
		.getEntries()
		.some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some((block) => block.type === "toolCall" && block.id === toolCallId),
		);
	const line: KillBarrierReport = {
		toolCallId,
		durable: callIsRecorded && sessionManager.isTranscriptFlushed(),
		sessionFile,
	};
	process.stdout.write(`${KILL_BARRIER_LINE_PREFIX}${JSON.stringify(line)}\n`);
}

const harness = await createHarness({
	sessionManager,
	cwd: root,
	tools: childTools(scenario, join(root, "ledger"), report),
});
harness.setResponses([
	fauxAssistantMessage(
		scenario.calls.map((call) => fauxToolCall(call.name, call.args, { id: call.id })),
		{ stopReason: "toolUse" },
	),
]);
await harness.session.prompt("run the kill-barrier scenario");
throw new Error("the kill-barrier turn ended before the process was killed");
