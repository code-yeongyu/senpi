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
// Solo compare (Z1.f "each equal to its single-session B0"): after the two-session run, each session is run again alone
// (support/solo-compare.mjs: its own sandbox, fake server and host, only its own turns) and its O6/O7 projection must
// equal the same session's projection from the two-session run; a difference fails the case.
import { HELD_TOOLS } from "./support/held.mjs";
import { attachSession, closeConnections, startMultiSessionHost } from "./support/multi-session-host.mjs";
import { WITHOUT_O8 } from "./support/observables.mjs";
import { assertSoloEqual, observeSession, runSolo } from "./support/solo-compare.mjs";

const write = (id, path, barrier) => ({ id, name: "eq_write", args: { path, text: `${id}\n`, barrier } });
const SESSIONS = {
	A: { call: "call_a", path: "out/a.txt", barrier: "a-body", done: "E30-A-DONE" },
	B: { call: "call_b", path: "out/b.txt", barrier: "b-body", done: "E30-B-DONE" },
};

/** Run session `name` alone: one prompt, its body released once it arrives, then its idle. */
function runAlone(run, name) {
	const s = SESSIONS[name];
	const pipeline = run.env.SENPI_EXECUTION_PIPELINE;
	const spec = {
		extensions: [HELD_TOOLS],
		files: { "out/.keep": "" },
		turns: [{ toolCalls: [write(s.call, s.path, s.barrier)] }, { text: s.done }],
		env: pipeline === undefined ? {} : { SENPI_EXECUTION_PIPELINE: pipeline },
	};
	return runSolo(spec, `e30-solo-${name.toLowerCase()}`, async (solo, connection) => {
		await connection.client.send(
			{ type: "prompt", sessionId: connection.sessionId, message: `write ${s.path}` },
			{ timeoutMs: 120_000 },
		);
		await solo.server.barrierArrived(s.barrier);
		solo.server.releaseBarrier(s.barrier);
		await ended(connection, s.call);
		await idle(connection, 0);
	});
}
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

		const concurrent = { A: observeSession(run, a), B: observeSession(run, b) };
		for (const name of ["A", "B"]) assertSoloEqual(name, concurrent[name], await runAlone(run, name));
	},
};
