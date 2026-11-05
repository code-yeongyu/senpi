// E25 fixture extension (plan X13 `unparseable-question`, as its kill-barrier fixture does): for one child only, a tool
// under the ask-user tool name accepts any arguments and holds on barrier `stale-question`, so the session file ends with
// an `ask_user_question` call whose recorded arguments do not form a question (what a transcript written by another
// version leaves). The case kills that child and reopens the session without this fixture: today's ask-user resume must
// settle the call `orphaned-after-restart`.
//
// The built-in ask-user extension registers its tools on session_start, so this one registers there too (extensions
// passed with --extension run after the built-ins, and the later registration of a name wins).
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";

export default function staleQuestion(pi) {
	pi.on("session_start", () => {
		pi.registerTool({
			name: "ask_user_question",
			label: "EQ stale question",
			description: "EQ fixture: stands in for a question whose recorded arguments no longer parse.",
			parameters: Type.Object({}, { additionalProperties: true }),
			async execute(toolCallId, _params, signal, _onUpdate, ctx) {
				await appendFile(resolve(ctx.cwd, "ledger.txt"), `${toolCallId}\n`);
				const response = await fetch(`${process.env.EQ_BARRIER_ORIGIN}/__barrier/stale-question`, { signal });
				await response.text();
				return { content: [{ type: "text", text: "stale question released" }], details: {} };
			},
		});
	});
}
