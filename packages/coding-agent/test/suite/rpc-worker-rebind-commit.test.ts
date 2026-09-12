import { execFileSync } from "node:child_process";
import type { open } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startWorkerHost, waitForFifoReader } from "./rpc-worker-host-support.ts";

it("commits replacement identity before a replacement callback blocks", async () => {
	const host = await startWorkerHost(`import {readFileSync} from 'node:fs'; import {join} from 'node:path';
		export default function(pi) {
			const gate=join(process.cwd(),'rebind-gate');
			pi.registerCommand('replace',{description:'test replacement commit',handler:async(_args,ctx)=>{await ctx.newSession({withSession:async()=>{readFileSync(gate);}});}});
		}`);
	const fifo = join(host.cwd, "rebind-gate");
	execFileSync("mkfifo", [fifo]);
	let gate: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const opened = await host.request({ type: "open_session", cwd: host.cwd });
		expect(opened.success).toBe(true);
		const replaced = host.wait((record) => record.type === "session_replaced");
		const command = host.request({ type: "prompt", sessionId: opened.data?.sessionId, message: "/replace" });
		const drained = Promise.allSettled([replaced, command]);
		const identity = await replaced;
		gate = await waitForFifoReader(fifo);
		try {
			const attached = await host.request({
				type: "open_session",
				cwd: host.cwd,
				sessionPath: identity.sessionFile,
			});
			expect(attached.success).toBe(true);
			expect(attached.data?.attached).toBe(true);
			expect(attached.data?.sessionId).toBe(opened.data?.sessionId);
			expect(attached.data?.state?.sessionId).toBe(identity.durableSessionId);
		} finally {
			await gate.write("release");
			await gate.close();
			gate = undefined;
			await command;
			await drained;
		}
	} finally {
		await gate?.close();
		await host.dispose();
	}
}, 60_000);
