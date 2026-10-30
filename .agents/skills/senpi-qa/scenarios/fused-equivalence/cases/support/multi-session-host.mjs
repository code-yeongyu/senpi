// Today's shared multi-session RPC host for EQ cases that put more than one connection or session on one engine process
// (E30): `--mode rpc --multi-session --listen <socket> --session-runtime in-process`, every session on the host's own
// event loop. Connections attach through the RpcClient's socket bridge.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCli } from "../../../../scripts/lib/common.mjs";
import { RpcClient } from "../../../../scripts/lib/rpc-client.mjs";

const OPEN_TIMEOUT_MS = 120_000;

/** Start the host for this run; resolves with its socket once it listens. The run's cleanups stop it. */
export function startMultiSessionHost(run) {
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
		{ env: run.env, cwd: run.box.cwd },
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

/** Attach a new connection and open a session on it; returns the connection, its session id and file. */
export async function attachSession(run, socket, open) {
	const client = new RpcClient({ env: run.env, cwd: run.box.cwd, attach: socket });
	run.clients.push(client);
	const opened = await client.send({ type: "open_session", ...open }, { timeoutMs: OPEN_TIMEOUT_MS });
	if (!opened.success) throw new Error(`open_session failed: ${JSON.stringify(opened).slice(0, 400)}`);
	const sessionId = opened.data.sessionId;
	const state = await client.send({ type: "get_state", sessionId }, { timeoutMs: OPEN_TIMEOUT_MS });
	if (!state.success) throw new Error(`get_state failed: ${JSON.stringify(state).slice(0, 400)}`);
	return { client, sessionId, sessionFile: state.data.sessionFile };
}

/** Close the connections in order, each after its bridge has exited, so every event list is complete. */
export async function closeConnections(connections) {
	for (const { client } of connections) {
		client.close();
		if (client.child.exitCode === null) await new Promise((resolve) => client.child.once("close", resolve));
	}
}
