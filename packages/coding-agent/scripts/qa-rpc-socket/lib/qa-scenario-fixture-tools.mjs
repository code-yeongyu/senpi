/**
 * `5-fixture-tools`: the one scenario runnable at todo 5. A real host with the fixture extension
 * loaded runs `qa_sink` and `qa_blob` from a scripted model turn; the driver awaits each
 * `tool_execution_end` and checks the sink digest and the blob size from the tool results.
 */
import { createHash } from "node:crypto";
import { QaFailure } from "./qa-failure.mjs";

const PAYLOAD = "qa-fixture-payload-✓";
const BLOB_BYTES = 4096;
const STEPS = [
	{ tool: "qa_sink", args: { payload: PAYLOAD } },
	{ tool: "qa_blob", args: { bytes: BLOB_BYTES } },
	{ text: "QA fixture tools done" },
];

function resultText(record) {
	const content = record.result?.content;
	return Array.isArray(content) ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("") : "";
}

export const fixtureToolsScenario = Object.freeze({
	id: "5-fixture-tools",
	requires: [],
	needsExtension: true,
	model(body) {
		const toolMessages = (body.messages ?? []).filter((message) => message.role === "tool").length;
		return STEPS[Math.min(toolMessages, STEPS.length - 1)];
	},
	async run(ctx) {
		const sessionId = await ctx.openSession();
		const ended = (tool) =>
			ctx.awaitRecord((r) => r.sessionId === sessionId && r.type === "tool_execution_end" && r.toolName === tool, {
				name: `tool_execution_end ${tool}`,
				deadlineMs: 60_000,
			});
		const sink = ended("qa_sink");
		const blob = ended("qa_blob");
		const settled = ctx.awaitRecord((r) => r.sessionId === sessionId && r.type === "agent_settled", {
			name: "agent_settled",
			deadlineMs: 120_000,
		});
		await ctx.prompt(sessionId, "run the QA fixture tools");
		const sinkRecord = await sink;
		const blobRecord = await blob;
		await settled;
		const digest = createHash("sha256").update(PAYLOAD, "utf8").digest("hex");
		const sinkText = resultText(sinkRecord);
		const blobBytes = Buffer.byteLength(resultText(blobRecord), "utf8");
		ctx.log.write({ type: "assert", tool: "qa_sink", isError: sinkRecord.isError, digestMatches: sinkText === digest });
		ctx.log.write({ type: "assert", tool: "qa_blob", isError: blobRecord.isError, bytes: blobBytes });
		if (sinkRecord.isError || sinkText !== digest) throw new QaFailure("assertion_failed", `qa_sink returned ${sinkText.slice(0, 80)}`);
		if (blobRecord.isError || blobBytes !== BLOB_BYTES) throw new QaFailure("assertion_failed", `qa_blob returned ${blobBytes} bytes`);
	},
});
