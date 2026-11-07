// A background task stand-in using the real engine's child reports and delivery custody.
// Complete on the event-loop turn after settlement: the parent first becomes idle with a live child.
import { Type } from "typebox";
import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { startFakeModelServer } from "../../../../scripts/lib/fake-model-server.mjs";
import { writeMockModelsJson } from "../../../../scripts/lib/mock-loop-support.mjs";
import { RpcClient } from "../../../../scripts/lib/rpc-client.mjs";

/** A real, persisted child session executes eval, including its nested read and real hooks. */
async function childEval() {
	const server = await startFakeModelServer({ turns: [
		{ toolCalls: [{ id: "child-eval", name: "eval", args: {
			language: "js", summary: "read child fixture",
			code: 'print(await tool.read({ path: "src/math.mjs" }));',
		} }] },
		{ text: "4" },
	] });
	const dir = join(process.env.HOME, "self-test-child");
	const agentDir = join(dir, "agent");
	const sessionDir = join(dir, "sessions");
	for (const path of [agentDir, sessionDir]) mkdirSync(path, { recursive: true, mode: 0o700 });
	cpSync(join(process.env.SENPI_CODING_AGENT_DIR, "extensions"), join(agentDir, "extensions"), { recursive: true });
	writeMockModelsJson(agentDir, { origin: server.origin, url: `${server.origin}/v1` }, "openai-completions");
	const client = new RpcClient({
		cwd: process.cwd(),
		env: { ...process.env, SENPI_CODING_AGENT_DIR: agentDir, SENPI_CODING_AGENT_SESSION_DIR: sessionDir },
		extraArgs: ["--provider", "mock", "--model", "mock-model", "--no-skills"],
	});
	try {
		const state = await client.send({ type: "get_state" }, { timeoutMs: 180_000 });
		if (!state.success) throw new Error("child get_state failed");
		const idle = client.waitForEvent((event) => event.type === "agent_idle", { timeoutMs: 180_000 });
		const sent = await client.send({ type: "prompt", message: "Read src/math.mjs with eval, then answer 4." });
		if (!sent.success) throw new Error("child prompt failed");
		await idle;
		return state.data.sessionId;
	} finally {
		const closed = new Promise((resolve) => client.child.once("close", resolve));
		client.close();
		await closed;
		await server.stop();
	}
}

export default function selfTestTask(pi) {
	let pending;
	pi.on("agent_settled", () => {
		if (!pending) return;
		const { report, obligation, child } = pending;
		pending = undefined;
		setImmediate(async () => {
			const childSessionId = await child;
			pi.lifecycle.reportChild({ ...report, childSessionId, generation: 1, state: "done", terminal: "completed" });
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
			const child = childEval();
			child.catch(() => {});
			pending = { report, obligation, child };
			return {
				content: [{ type: "text", text: "Started st_live_child" }],
				details: { task_id: report.taskId, run_epoch: 0, status: "running" },
			};
		},
	});
}
