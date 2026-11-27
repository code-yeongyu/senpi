import { on, once } from "node:events";
import { readFileSync, watch } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startWorkerHost } from "../rpc-worker-host-support.ts";

// senpi#7588: every peer delivery held while paused reaches the model once, in admission order, across a host restart;
// a resend of a held id after the restart is answered already_admitted rather than held a second time.

const faux = new URL("../../../../ai/dist/providers/faux.js", import.meta.url).href;
const options = { node: true, sessionRuntime: "in-process", waitForReady: true } as const;
const extension = `import { writeFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from ${JSON.stringify(faux)};
export default function(pi) {
  const f = fauxProvider({api:"fifo",provider:"fifo"});
  f.setResponses([ctx => {
    const markers = JSON.stringify(ctx.messages).match(/fifo-payload-[123]/g);
    if (process.env.FIFO_PHASE === "interrupt") return fauxAssistantMessage([fauxToolCall("wait_gate", {})], {stopReason:"toolUse"});
    writeFileSync("model-input.json", JSON.stringify(markers ?? []));
    return fauxAssistantMessage("received");
  }]);
  pi.registerProvider(f.provider);
  pi.registerTool({name:"wait_gate", label:"Gate", description:"Wait for process termination",parameters:{type:"object",properties:{}}, execute:()=>{writeFileSync("entered","");return new Promise(()=>{})}});
}`;

async function afterFileAppears(cwd: string, name: string, action: () => Promise<void>) {
	const watcher = watch(cwd);
	try {
		const observed = on(watcher, "change", { signal: AbortSignal.timeout(10_000) });
		await action();
		for await (const [, file] of observed) if (file === name) break;
	} finally {
		watcher.close();
	}
}

async function kill(host: Awaited<ReturnType<typeof startWorkerHost>>) {
	const exited = once(host.child, "exit");
	host.child.kill("SIGKILL");
	expect((await exited)[1]).toBe("SIGKILL");
}

it.each([false, true])(
	"presents held peer deliveries to the provider in admission order exactly once (session reopened after admission: %s)",
	async (restart) => {
		const hosts: Awaited<ReturnType<typeof startWorkerHost>>[] = [];
		async function start() {
			const host = await startWorkerHost(extension, {
				...options,
				env: { FIFO_PHASE: hosts.length ? "resume" : "interrupt" },
			});
			hosts.push(host);
			return host;
		}
		try {
			const first = await start();
			const original = await first.request({ type: "open_session", provider: "fifo", modelId: "faux-1" });
			expect(original.success).toBe(true);
			const id = original.data?.sessionId;
			const file = (await first.request({ type: "list_sessions" })).data?.sessions?.find(
				(s) => s.sessionId === id,
			)?.sessionPath;
			if (!file) throw new Error("no session file");
			await afterFileAppears(first.cwd, "entered", async () => {
				first.send({ type: "prompt", sessionId: id, message: "enter gate" });
			});
			await kill(first);
			const reopen = async () => {
				const host = await start();
				const open = await host.request({
					type: "open_session",
					cwd: first.cwd,
					sessionPath: file,
					attended: false,
				});
				expect(open.success).toBe(true);
				return { host, sessionId: open.data?.sessionId };
			};
			let { host, sessionId } = await reopen();
			for (const [n, kind] of [
				[1, "held"],
				[2, "held"],
				[2, "already_admitted"],
				[3, "held"],
			] as const) {
				const result = await host.request({
					type: "admit_external_message",
					sessionId,
					deliveryId: `delivery-${n}`,
					text: `fifo-payload-${n}`,
					sender: { kind: "agent", session_id: "sender" },
					deliverAs: "followUp",
				});
				expect(result).toMatchObject({ success: true, data: { kind } });
			}
			if (restart) {
				// A fresh session runtime starts with an empty admission ledger, as a replaced host process does; only the
				// session file answers for what was admitted before.
				expect((await host.request({ type: "close_session", sessionId })).success).toBe(true);
				const reopened = await host.request({
					type: "open_session",
					cwd: first.cwd,
					sessionPath: file,
					attended: false,
				});
				expect(reopened.success).toBe(true);
				sessionId = reopened.data?.sessionId;
				for (const n of [2, 1]) {
					const resend = await host.request({
						type: "admit_external_message",
						sessionId,
						deliveryId: `delivery-${n}`,
						text: `fifo-payload-${n}`,
						sender: { kind: "agent", session_id: "sender" },
						deliverAs: "followUp",
					});
					expect(resend).toMatchObject({ success: true, data: { kind: "already_admitted" } });
				}
			}
			const state = (await host.request({ type: "get_state", sessionId })).data;
			expect(state).toMatchObject({
				paused: true,
				holds: expect.arrayContaining([expect.objectContaining({ key: "interrupted-run" })]),
			});
			const pause = state?.pause;
			if (!pause || typeof pause !== "object" || !("pauseSeq" in pause) || typeof pause.pauseSeq !== "number")
				throw new Error("reopened session omitted its pause sequence");
			const seq = pause.pauseSeq;
			await afterFileAppears(host.cwd, "model-input.json", async () => {
				expect(
					await host.request({ type: "resume_session", sessionId, expectedSeq: seq, unlessStopped: true }),
				).toMatchObject({ success: true, data: { resumed: true, turnStarted: true } });
			});
			expect(JSON.parse(readFileSync(join(host.cwd, "model-input.json"), "utf8"))).toEqual([
				"fifo-payload-1",
				"fifo-payload-2",
				"fifo-payload-3",
			]);
		} finally {
			for (const host of hosts.reverse()) await host.dispose();
		}
	},
);
