// A user extension for the senpi#5898 loop-event tables: every notification handler reports the event it received as a
// notice (which rides the reply to the loop), and every interceptor returns a result built from the event's fields, so
// a hosted loop's hand and a local session can be compared on the same extension.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";

const note = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 0 });

const seen = (event: object, ctx: ExtensionContext) => ctx.ui.notify(JSON.stringify(event));

export default function loopEventExtension(pi: ExtensionAPI): void {
	pi.on("agent_start", seen);
	pi.on("agent_settled", seen);
	pi.on("turn_start", seen);
	pi.on("message_start", seen);
	pi.on("message_update", seen);
	pi.on("system_prompt_change", seen);
	pi.on("thinking_level_select", seen);
	pi.on("session_info_changed", seen);
	pi.on("session_hold_changed", seen);
	pi.on("held_wakes_released", seen);
	pi.on("session_tree", seen);
	pi.on("session_parked", seen);
	pi.on("session_resumed", seen);
	pi.on("session_abort", seen);
	pi.on("after_provider_response", seen);
	pi.on("provider_stream_event", seen);
	pi.on("input_disposition", seen);
	pi.on("session_control_wake", seen);
	pi.on("context", (event) => ({ messages: [...event.messages, note(`context ${event.source}`)] }));
	pi.on("context_with_system", (event) => ({ messages: [...event.messages, note("with system")] }));
	pi.on("session_before_switch", (event) => ({ cancel: event.reason === "resume" }));
	pi.on("session_before_fork", (event) => ({ skipConversationRestore: event.position === "at" }));
	pi.on("session_before_tree", (event) => ({
		summary: {
			summary: `${event.preparation.entriesToSummarize.length} to ${event.preparation.targetId}, aborted ${event.signal.aborted}`,
		},
		label: `${event.preparation.label}`,
	}));
	pi.on("turn_end", (event) => ({
		entries: [
			...event.entries,
			{ type: "custom", customType: "turn", data: { index: event.turnIndex, outcome: event.outcome } },
		],
		continue: event.context.canContinue,
	}));
	pi.on("agent_before_settle", (event) => ({
		entries: [
			...event.entries,
			{ type: "custom", customType: "settle", data: { pending: event.context.pendingMessages.length } },
		],
		continue: true,
	}));
	pi.on("message_end", (event) =>
		event.message.role === "assistant"
			? { message: { ...event.message, content: [{ type: "text", text: "rewritten" }] } }
			: undefined,
	);
	pi.on("model_select", (event) => ({
		systemPrompt: `${event.systemPrompt} for ${event.model.id} after ${event.previousModel?.id}`,
		systemPromptName: event.source,
	}));
	pi.on("provider_login_start", (event) => event.progress(`login ${event.provider}, aborted ${event.signal.aborted}`));
	pi.on("session_move_export", (event) => {
		mkdirSync(join(event.dir, "loop-event-ext"), { recursive: true });
		writeFileSync(join(event.dir, "loop-event-ext", "state.json"), JSON.stringify({ moveId: event.moveId }));
	});
	pi.on("session_move_import", (event, ctx) =>
		ctx.ui.notify(`${readFileSync(join(event.dir, "loop-event-ext", "state.json"), "utf-8")} ${event.redelivered}`),
	);
}
