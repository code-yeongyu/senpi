// E30 (plan §6.4, Z1.f): two sessions in one engine process at once, interleaved tool calls. O1-O7.
//
// Today's mechanism for more than one session in one engine process is the shared multi-session RPC host with the
// in-process session runtime (every session on the host's event loop; packages/coding-agent/src/modes/rpc/
// session-registry.ts). Connection A opens session A and connection B opens session B on that host. The tool calls
// interleave, ordered by barriers, never by timing:
// 1. A's turn dispatches eq_write(out/a.txt), held on barrier a-body;
// 2. while A's body is in flight, B prompts; B's turn dispatches eq_write(out/b.txt), held on b-body;
// 3. b-body is released; B's tool ends, B's next turn answers, B goes idle;
// 4. a-body is released; A's tool ends, A's next turn answers, A goes idle.
// Each connection's event stream is its own O6 (a connection receives its session's records and today's broadcast
// lifecycle records); O7 is session A's transcript with session B's under `peers`; O5 records which bodies were in
// flight at each release. A tool result delivered to the other session shows in O6/O7.
import { HELD_TOOLS } from "./support/held.mjs";
import { attachSession, closeConnections, startMultiSessionHost } from "./support/multi-session-host.mjs";
import { WITHOUT_O8 } from "./support/observables.mjs";

const write = (id, path, barrier) => ({ id, name: "eq_write", args: { path, text: `${id}\n`, barrier } });
const ended = (connection, toolCallId) =>
	connection.client.waitForEvent((e) => e.type === "tool_execution_end" && e.toolCallId === toolCallId, {
		timeoutMs: 120_000,
	});
const idle = (connection, after) =>
	connection.client.waitForEvent(
		(e) =>
			e.type === "agent_idle" &&
			e.sessionId === connection.sessionId &&
			connection.client.events.indexOf(e) >= after,
		{ timeoutMs: 120_000 },
	);

export default {
	id: "E30",
	title: "two sessions in one engine process at once, interleaved tool calls",
	observables: WITHOUT_O8,
	spec: {
		extensions: [HELD_TOOLS],
		files: { "out/.keep": "" },
		turns: [
			{ toolCalls: [write("call_a", "out/a.txt", "a-body")] },
			{ toolCalls: [write("call_b", "out/b.txt", "b-body")] },
			{ text: "E30-B-DONE" },
			{ text: "E30-A-DONE" },
		],
	},
	async drive(run) {
		const socket = await startMultiSessionHost(run);
		const a = await attachSession(run, socket, { cwd: run.box.cwd });
		const b = await attachSession(run, socket, { cwd: run.box.cwd });
		run.sessionFile = a.sessionFile;
		run.sessionIds.push(a.sessionId);
		run.peerSessionFiles = [b.sessionFile];
		const inFlight = new Set();
		for (const name of ["a-body", "b-body"]) run.server.barrierArrived(name).then(() => inFlight.add(name));
		const release = async (barrier) => {
			await run.server.barrierArrived(barrier);
			await Promise.resolve();
			run.effects.push({ release: barrier, arrivedBefore: [...inFlight].sort() });
			run.server.releaseBarrier(barrier);
		};

		const aStart = a.client.events.length;
		await a.client.send(
			{ type: "prompt", sessionId: a.sessionId, message: "write out/a.txt" },
			{ timeoutMs: 120_000 },
		);
		await run.server.barrierArrived("a-body");
		const bStart = b.client.events.length;
		await b.client.send(
			{ type: "prompt", sessionId: b.sessionId, message: "write out/b.txt" },
			{ timeoutMs: 120_000 },
		);
		await release("b-body");
		await ended(b, "call_b");
		await idle(b, bStart);
		await release("a-body");
		await ended(a, "call_a");
		await idle(a, aStart);
		// agent_idle is a broadcast lifecycle record: B's stream is complete only once A's idle has reached it too.
		await b.client.waitForEvent((e) => e.type === "agent_idle" && e.sessionId === a.sessionId, {
			timeoutMs: 120_000,
		});
		await closeConnections([b, a]);
	},
};
