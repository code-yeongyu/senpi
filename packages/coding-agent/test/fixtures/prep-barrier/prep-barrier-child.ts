import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness } from "../../suite/harness.ts";
import {
	PREP_BARRIER_LINE_PREFIX,
	PREP_BARRIER_SCENARIOS,
	PREP_TOOL_NAME,
	type PrepBarrierReport,
	type PrepBarrierScenarioName,
	prepBarrierHook,
	prepBarrierTool,
} from "./prep-barrier.ts";

function isScenarioName(value: string | undefined): value is PrepBarrierScenarioName {
	return value !== undefined && Object.hasOwn(PREP_BARRIER_SCENARIOS, value);
}

const [scenarioName, root] = process.argv.slice(2);
if (!isScenarioName(scenarioName) || root === undefined) {
	throw new Error("usage: prep-barrier-child.ts <scenario> <root>");
}
const scenario = PREP_BARRIER_SCENARIOS[scenarioName];
const trace = join(root, "trace");
const sessionManager = SessionManager.create(root, join(root, "sessions"));

function report(toolCallId: string): void {
	const sessionFile = sessionManager.getSessionFile();
	if (sessionFile === undefined) throw new Error("prep-barrier child has no session file");
	const callIsRecorded = sessionManager
		.getEntries()
		.some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some((block) => block.type === "toolCall" && block.id === toolCallId),
		);
	const line: PrepBarrierReport = {
		toolCallId,
		durable: callIsRecorded && sessionManager.isTranscriptFlushed(),
		sessionFile,
	};
	process.stdout.write(`${PREP_BARRIER_LINE_PREFIX}${JSON.stringify(line)}\n`);
}

const harness = await createHarness({
	sessionManager,
	cwd: root,
	tools: [prepBarrierTool(trace)],
	extensionFactories: [prepBarrierHook(trace, { id: scenario.barrierId, reached: report })],
});
await harness.session.bindExtensions({});
harness.setResponses([
	fauxAssistantMessage(
		scenario.calls.map((call) => fauxToolCall(PREP_TOOL_NAME, { ...call.args }, { id: call.id })),
		{ stopReason: "toolUse" },
	),
]);
await harness.session.prompt("run the prep-barrier scenario");
throw new Error("the prep-barrier turn ended before the process was killed");
