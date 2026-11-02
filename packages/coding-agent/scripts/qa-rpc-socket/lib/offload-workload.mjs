/**
 * The offload profiling workload, ported verbatim from the planning driver (`run-profile.ts:53-74`):
 * two rounds of eval(grep x2), read, todo, eval(bash), write, edit, eval(grep), then one final text,
 * i.e. 14 `tool_execution_end` records per session ({eval:6, read:2, todo:2, write:2, edit:2}). Nested
 * kernel calls (`tool.grep` inside eval) are not top-level `tool_execution_end` records.
 *
 * Mutations prove the oracle fails closed: `no-exec` answers with a final text right after the first
 * tool, so the remaining tools never execute (`tool_count_mismatch`); `force-timeout` holds the first
 * model response forever, so no turn settles (`turn_timeout`).
 */
import { textOf } from "./mock-model.mjs";

export const MUTATIONS = Object.freeze(["no-exec", "force-timeout"]);

function round(n) {
	const scratch = `eop-scratch-${n}.txt`;
	return [
		{ tool: "eval", args: { language: "js", summary: "scan", code: `const r = await Promise.all([tool.grep({ pattern: "export (async )?function", path: "packages" }), tool.grep({ pattern: "import .* from", path: "packages" })]); print(r.map((x) => (x.text ?? "").length));` } },
		{ tool: "read", args: { path: "packages/coding-agent/src/core/session-manager.ts" } },
		{
			tool: "todo",
			args: {
				op: "init",
				list: [{ phase: "P", items: Array.from({ length: 40 }, (_, i) => `profile item ${n}-${i} with some text`) }],
			},
		},
		{ tool: "eval", args: { language: "js", summary: "shell", code: `const r = await tool.bash({ command: "git log --oneline -3000 | wc -l && ls packages | head" }); print((r.text ?? "").slice(0, 200));` } },
		{ tool: "write", args: { path: scratch, content: Array.from({ length: 2000 }, (_, i) => `line ${i} of ${n}`).join("\n") } },
		{ tool: "edit", args: { path: scratch, edits: [{ oldText: "line 1000 of", newText: "LINE 1000 of" }] } },
		{ tool: "eval", args: { language: "js", summary: "todo scan", code: `const r = await tool.grep({ pattern: "TODO|FIXME", path: "." }); print((r.text ?? "").length);` } },
		{ text: `EOP done ${n}` },
	];
}

export function workload(n) {
	const one = round(n);
	return [...one.slice(0, -1), ...round(n).slice(0, -1), one.at(-1)];
}

export function sessionPrompt(n) {
	return `EOP-SESSION-${n} run the profile workload`;
}

/** The mock-model responder for a run: the workload step for the session's tool-result count. */
export function workloadResponder(mutate) {
	return (body) => {
		const messages = body.messages ?? [];
		const users = messages.filter((m) => m.role === "user").map((m) => textOf(m.content));
		const latest = users.at(-1) ?? "";
		if (/summar/i.test(latest) && !latest.startsWith("EOP-SESSION-")) return { text: "## Summary\nprofile run" };
		const session = /EOP-SESSION-(\d+)/.exec(users.join("\n"));
		if (!session) return { text: "ok" };
		if (mutate === "force-timeout") return { hold: true };
		const steps = workload(Number(session[1]));
		const done = messages.filter((m) => m.role === "tool").length;
		if (mutate === "no-exec" && done >= 1) return steps.at(-1);
		return steps[Math.min(done, steps.length - 1)];
	};
}
