// E17 (plan §6.4, K2): a permission approved over RPC by a client and by another session. O1-O8.
//
// The CLI runs as today's shared multi-session RPC host (`--multi-session --listen <socket>`). Connection A opens the
// session with the `ask` permission preset and prompts; the first tool call asks, and A approves it with an
// extension_ui_response. Connection B, a second client, then attaches to the same session (open_session with its
// sessionPath); the second tool call asks, and B approves it. Both writes run (O5); both connections' event streams are
// O6; a headless reopen reads the final state (O8).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCli } from "../../../scripts/lib/common.mjs";
import { RpcClient } from "../../../scripts/lib/rpc-client.mjs";
import { HELD_TOOLS } from "./support/held.mjs";
import { ALL_OBSERVABLES } from "./support/observables.mjs";

const write = (id, path) => ({ id, name: "eq_write", args: { path, text: `${id}\n`, barrier: `open-${id}` } });

function startHost(run) {
	const socketDir = mkdtempSync(join(tmpdir(), "eqh-"));
	const socket = join(socketDir, "h.sock");
	const host = spawnCli(
		[
			"--mode",
			"rpc",
			"--multi-session",
			"--listen",
			socket,
			"--session-runtime",
			"in-process",
			"--no-context-files",
			...run.args,
		],
		{
			env: run.env,
			cwd: run.box.cwd,
		},
	);
	run.cleanups.push(async () => {
		if (host.exitCode === null && host.signalCode === null) {
			const closed = new Promise((resolve) => host.once("close", resolve));
			host.kill("SIGTERM");
			await closed;
		}
		rmSync(socketDir, { recursive: true, force: true });
	});
	return new Promise((resolve, reject) => {
		let stderr = "";
		host.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
			if (stderr.includes("senpi rpc listening on")) resolve(socket);
		});
		host.once("close", (code) => reject(new Error(`RPC host exited ${code}: ${stderr.slice(-400)}`)));
	});
}

async function attach(run, socket, open) {
	const client = new RpcClient({ env: run.env, cwd: run.box.cwd, attach: socket });
	run.clients.push(client);
	const opened = await client.send({ type: "open_session", ...open }, { timeoutMs: 120_000 });
	if (!opened.success) throw new Error(`open_session failed: ${JSON.stringify(opened).slice(0, 400)}`);
	const sessionId = opened.data.sessionId;
	const state = await client.send({ type: "get_state", sessionId }, { timeoutMs: 120_000 });
	if (!state.success) throw new Error(`get_state failed: ${JSON.stringify(state).slice(0, 400)}`);
	run.sessionFile ??= state.data.sessionFile;
	run.sessionIds.push(state.data.sessionId);
	return { client, sessionId, pendingDialogs: opened.data.state?.pendingDialogs ?? [] };
}

/**
 * Approve the ask for this tool call: from the dialogs already pending when this connection opened the session (a
 * connection that attaches later reads them from open_session), else from the ask event this connection receives.
 */
async function approveNextAsk({ client, sessionId, pendingDialogs }, toolCallId) {
	const pending = pendingDialogs.find((dialog) => dialog.toolCallId === toolCallId);
	const ask =
		pending ??
		(await client.waitForEvent(
			(e) => e.type === "extension_ui_request" && e.method === "select" && e.toolCallId === toolCallId,
			{
				timeoutMs: 120_000,
			},
		));
	const reply = await client.send(
		{ type: "extension_ui_response", sessionId, id: ask.id, value: "Allow once" },
		{ timeoutMs: 120_000 },
	);
	if (!reply.success) throw new Error(`approval refused: ${JSON.stringify(reply).slice(0, 400)}`);
}

export default {
	id: "E17",
	title: "permission approved over RPC by a client and by another session (K2)",
	observables: ALL_OBSERVABLES,
	spec: {
		extensions: [HELD_TOOLS],
		files: { "out/.keep": "" },
		turns: [
			{ toolCalls: [write("call_by_client", "out/client.txt")] },
			{ toolCalls: [write("call_by_other", "out/other.txt")] },
			{ text: "E17-DONE" },
		],
	},
	async drive(run) {
		run.server.releaseBarrier("open-call_by_client");
		run.server.releaseBarrier("open-call_by_other");
		const socket = await startHost(run);
		const a = await attach(run, socket, { cwd: run.box.cwd, permissionPreset: "ask" });
		const idle = a.client.waitForEvent((e) => e.type === "agent_idle", { timeoutMs: 120_000 });
		idle.catch(() => {});
		await a.client.send(
			{ type: "prompt", sessionId: a.sessionId, message: "write two files" },
			{ timeoutMs: 120_000 },
		);
		await approveNextAsk(a, "call_by_client");
		await a.client.waitForEvent((e) => e.type === "tool_execution_end" && e.toolCallId === "call_by_client", {
			timeoutMs: 120_000,
		});
		// B attaches only once the second ask is pending (A sees it), so B always finds it among the open session's
		// pending dialogs: the attach never races the ask.
		await a.client.waitForEvent(
			(e) => e.type === "extension_ui_request" && e.method === "select" && e.toolCallId === "call_by_other",
			{ timeoutMs: 120_000 },
		);
		const b = await attach(run, socket, { sessionPath: run.sessionFile, cwd: run.box.cwd });
		await approveNextAsk(b, "call_by_other");
		await idle;
		for (const { client } of [b, a]) {
			client.close();
			if (client.child.exitCode === null) await new Promise((resolve) => client.child.once("close", resolve));
		}
		await run.reopenState();
	},
};
