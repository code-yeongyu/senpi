// E06 fixture: a search-exposed (inactive) tool, a lazy activator for it, and a tool_activated listener that records
// every activation into activation.log in the session cwd (an O5 effect).
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";

export default function lazyTool(pi) {
	pi.registerTool({
		name: "eq_lazy",
		label: "EQ lazy",
		description: "EQ fixture: an inactive tool activated on first use.",
		exposure: "search",
		parameters: Type.Object({ value: Type.String() }),
		async execute(_toolCallId, params) {
			return { content: [{ type: "text", text: `lazy:${params.value}` }], details: {} };
		},
	});
	pi.registerLazyToolActivator((toolName) => {
		if (toolName !== "eq_lazy") return false;
		pi.setActiveTools([...pi.getActiveTools(), toolName]);
		return true;
	});
	pi.on("tool_activated", (event, ctx) => {
		appendFileSync(join(ctx.cwd, "activation.log"), `activated:${event.toolNames.join(",")}\n`);
	});
}
