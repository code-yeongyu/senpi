// E18 fixture: a tool whose body runs another session tool through ctx.executeTool (nested call, B6).
import { Type } from "typebox";

export default function nestedTool(pi) {
	pi.registerTool({
		name: "eq_nested",
		label: "EQ nested",
		description: "EQ fixture: reads <path> through a nested read call.",
		parameters: Type.Object({ path: Type.String() }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const inner = await ctx.executeTool("read", { path: params.path });
			const innerText = inner.content.map((part) => (part.type === "text" ? part.text : `<${part.type}>`)).join("");
			return { content: [{ type: "text", text: `nested:${innerText}` }], details: {} };
		},
	});
}
