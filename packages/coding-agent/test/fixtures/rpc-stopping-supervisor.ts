/** Real supervisor; only the socket child's exit and open completion are test-controlled. */
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { mock } from "node:test";
import { runHostSupervisor } from "../../src/modes/rpc/host-lifecycle.ts";
import { attachJsonlLineReader } from "../../src/modes/rpc/jsonl.ts";

const [mode, socket, agentDir] = process.argv.slice(2);
if (mode === "host" || mode === "successor-host") {
	const address = process.argv.find((arg) => arg.startsWith("unix://"))?.slice(7);
	if (!address) throw new Error("missing internal socket");
	let held = false;
	const pending: Array<() => void> = [];
	const peers = new Set<net.Socket>();
	const finish = () => {
		for (const peer of peers) peer.destroy();
		server.close(() => process.exit(0));
	};
	const server = net.createServer((peer) => {
		peers.add(peer);
		peer.once("close", () => peers.delete(peer));
		attachJsonlLineReader(peer, (line) => {
			const request = JSON.parse(line);
			const instanceId = process.env.SENPI_RPC_HOST_INSTANCE_ID;
			const answer = (data: object) =>
				peer.write(
					`${JSON.stringify({ id: request.id, type: "response", command: request.type, success: true, data })}\n`,
				);
			if (request.type === "get_protocol_info") {
				answer({
					protocolVersion: 1,
					serverVersion: "fixture",
					capabilities: ["multi_session", "extension_events", "session_context", "session_kind"],
					instanceId,
				});
			} else if (request.type === "open_session") {
				process.send?.({ type: "open-reached-child" });
				const complete = () =>
					answer({
						sessionId: instanceId,
						state: {
							sessionId: instanceId,
							sessionFile: `${request.cwd}/session.jsonl`,
							cwd: request.cwd,
							model: null,
						},
					});
				if (held) pending.push(complete);
				else complete();
			} else if (request.type === "list_sessions") answer({ sessions: [] });
			else answer({ echo: request });
		});
	});
	process.on("SIGTERM", () => {
		process.send?.({ type: "child-stopping" });
		if (mode === "successor-host") finish();
	});
	process.on("SIGUSR1", () => process.send?.({ type: "child-draining" }));
	process.on("message", (message) => {
		if (message === "exit") finish();
		if (message === "hold-open") {
			held = true;
			process.send?.({ type: "open-held" });
		}
		if (message === "release-open") for (const complete of pending.splice(0)) complete();
	});
	server.listen(address);
} else {
	if (!socket || !agentDir) throw new Error("missing supervisor paths");
	let child: childProcess.ChildProcess | undefined;
	const spawn = childProcess.spawn;
	mock.method(childProcess, "spawn", (...args: Parameters<typeof childProcess.spawn>) => {
		if (!Array.isArray(args[2]?.stdio)) throw new Error("expected explicit stdio");
		args[2] = { ...args[2], stdio: [...args[2].stdio, "ipc"] };
		child = spawn(...args);
		child.on("message", (message) => process.send?.(message));
		child.once("exit", () => process.send?.({ type: "child-exited" }));
		return child;
	});
	const createServer = net.createServer;
	mock.method(net, "createServer", (accept: (peer: net.Socket) => void) => {
		const server = createServer((peer) => {
			accept(peer);
			attachJsonlLineReader(peer, (line) => {
				const request = JSON.parse(line);
				if (request.type === "get_protocol_info") process.send?.({ type: "public-probe" });
			});
		});
		server.once("listening", () => process.send?.({ type: "ready" }));
		return server;
	});
	syncBuiltinESMExports();
	process.on("message", (message) => {
		if (typeof message === "string") child?.send(message);
	});
	await runHostSupervisor({
		socket,
		agentDir,
		hostArgs: [],
		childCommand: process.execPath,
		childArgs: [import.meta.filename, mode === "successor" ? "successor-host" : "host"],
	});
}
