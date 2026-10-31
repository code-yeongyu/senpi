// A background task stand-in using the real engine's child reports and delivery custody.
// Complete on the event-loop turn after settlement: the parent first becomes idle with a live child.
import { Type } from "typebox";

export default function selfTestTask(pi) {
	let pending;
	pi.on("agent_settled", () => {
		if (!pending) return;
		const { report, obligation } = pending;
		pending = undefined;
		setImmediate(() => {
			pi.lifecycle.reportChild({ ...report, generation: 1, state: "done", terminal: "completed" });
			pi.sendMessage(
				{ customType: "task-result", content: "TASK_RESULT:4", display: true },
				{ triggerTurn: true, ticket: obligation.ticket() },
			);
		});
	});
	pi.registerTool({
		name: "task",
		label: "LIVE background task",
		description: "Count the fixture's exports in a background child.",
		parameters: Type.Object({ prompt: Type.String(), run_in_background: Type.Boolean() }),
		async execute() {
			const report = {
				taskId: "st_live_child",
				childSessionId: "live-child",
				runEpoch: 0,
				generation: 0,
				state: "running",
			};
			const obligation = pi.lifecycle.obligations.open("live-fixture:child", "children");
			pi.lifecycle.reportChild(report);
			pending = { report, obligation };
			return {
				content: [{ type: "text", text: "Started st_live_child" }],
				details: { task_id: report.taskId, run_epoch: 0, status: "running" },
			};
		},
	});
}
