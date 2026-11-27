import { once } from "node:events";
import { watch } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startWorkerHost } from "../suite/rpc-worker-host-support.ts";

const faux = new URL("../../../ai/dist/providers/faux.js", import.meta.url).href;
const extension = `import { writeFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from ${JSON.stringify(faux)};
export default function(pi) {
  const f = fauxProvider({ api: "row-test", provider: "row-test" });
  f.setResponses([fauxAssistantMessage([fauxToolCall("row_gate", {})], { stopReason: "toolUse" })]);
  pi.registerProvider(f.provider);
  pi.registerTool({name:"row_gate", label:"Gate", description:"Wait for process termination", parameters:{type:"object",properties:{}}, execute:()=>{writeFileSync("entered","");return new Promise(()=>{});}});
}`;

it("lists a session killed during a tool call with its interrupted hold and waiting deliveries", async () => {
	const opts = { node: true, sessionRuntime: "in-process", waitForReady: true } as const;
	const source = await startWorkerHost(extension, opts);
	try {
		const opened = await source.request({ type: "open_session", provider: "row-test", modelId: "faux-1" });
		expect(opened.success, opened.error).toBe(true);
		const sessionId = opened.data?.sessionId;
		const row = (await source.request({ type: "list_sessions" })).data?.sessions?.find((s) => s.sessionId === sessionId);
		if (!row?.sessionPath) throw new Error("no persisted session to reopen");
		const watcher = watch(source.cwd);
		try {
			const entered = new Promise<void>((resolve) => watcher.on("change", (_, name) => { if (name === "entered") resolve(); }));
			source.send({ type: "prompt", sessionId, message: "enter gate" });
			await entered;
		} finally {
			watcher.close();
		}
		const exited = once(source.child, "exit");
		source.child.kill("SIGKILL");
		expect((await exited)[1]).toBe("SIGKILL");

		const successor = await startWorkerHost(extension, opts);
		try {
			const reopened = await successor.request({ type: "open_session", sessionPath: row.sessionPath, cwd: join(source.scratch, "cwd"), attended: false });
			expect(reopened.success, reopened.error).toBe(true);
			const id = reopened.data?.sessionId;
			const point = await successor.request({ type: "get_state", sessionId: id });
			expect(point.data).toMatchObject({ paused: true, holds: expect.arrayContaining([expect.objectContaining({ key: "interrupted-run" })]) });
			for (const n of [1, 2, 3]) {
				expect(await successor.request({ type: "admit_external_message", sessionId: id, deliveryId: `msg-${n}`, text: `message ${n}`, sender: { kind: "agent", session_id: "peer" }, deliverAs: "followUp" })).toMatchObject({ success: true, data: { kind: "held" } });
			}
			const listed = (await successor.request({ type: "list_sessions" })).data?.sessions?.find((s) => s.sessionId === id);
			expect(listed).toMatchObject({ hold: { key: "interrupted-run", since: expect.any(String), queueDepth: 3 } });
		} finally {
			await successor.dispose();
		}
	} finally {
		await source.dispose();
	}
}, 90_000);
