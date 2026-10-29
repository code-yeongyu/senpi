// E08 fixture: the host `task` tool a detached cell's agent() dispatches to, with the P0-04a task fixture's typed
// results (packages/senpi-codemode/test/fixtures/task-fixture/task-fixture.ts): a foreground run returns its final
// text with `{task_id, run_epoch, status: "completed"}`, a background run returns the start record. Ids are
// deterministic (`st_0001`, ...).
import { Type } from "typebox";

const text = (value, details) => ({ content: [{ type: "text", text: value }], details });

export default function taskTool(pi) {
	let nextId = 0;
	pi.registerTool({
		name: "task",
		label: "EQ task",
		description: "EQ fixture: records a sub-agent task and returns a deterministic result.",
		parameters: Type.Object(
			{
				prompt: Type.String(),
				subagent_type: Type.Optional(Type.String()),
				run_in_background: Type.Optional(Type.Boolean()),
			},
			{ additionalProperties: true },
		),
		async execute(_toolCallId, params) {
			nextId += 1;
			const taskId = `st_${nextId.toString(16).padStart(4, "0")}`;
			if (params.run_in_background === true) {
				return text(`Started ${taskId}`, {
					kind: "started",
					task_id: taskId,
					status: "running",
					name: taskId,
					run_epoch: 0,
				});
			}
			return text(`TASK_RESULT:${params.prompt}`, { task_id: taskId, run_epoch: 0, status: "completed" });
		},
	});
}
