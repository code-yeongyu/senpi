import { appendFileSync } from "node:fs";
import { Type } from "file:///private/tmp/fix-142-codemode/node_modules/typebox/build/index.mjs";
const LOG = "/tmp/eval-fresh-qa/tool-calls.jsonl";
export default function (pi) {
	pi.registerTool({
		name: "demo_tool",
		label: "Demo Tool",
		description: "Returns a test marker. fresh-qa fixture.",
		parameters: Type.Object({ q: Type.String() }),
		async execute(_toolCallId, params) {
			appendFileSync(LOG, JSON.stringify({ ev: "execute", q: params.q }) + "\n");
			return { content: [{ type: "text", text: "demo:" + params.q }], details: {} };
		},
	});
	pi.on("tool_call", (event) => {
		if (event.toolName !== "demo_tool") return undefined;
		appendFileSync(LOG, JSON.stringify({ ev: "tool_call", input: { ...event.input } }) + "\n");
		return undefined;
	});
	pi.on("tool_result", (event) => {
		if (event.toolName !== "demo_tool") return undefined;
		const text = event.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
		appendFileSync(LOG, JSON.stringify({ ev: "tool_result", text }) + "\n");
		return { content: [{ type: "text", text: text + ":rewritten" }], details: event.details };
	});
}
