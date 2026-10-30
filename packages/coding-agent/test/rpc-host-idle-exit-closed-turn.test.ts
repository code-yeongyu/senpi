/**
 * A session closed mid-turn must not pin its REAL supervisor's idle exit forever. The close seals the
 * session before the aborted turn's `agent_settled` is written, so the host publishes the settle the
 * observer is owed (`reason: "session_closed"`) before it seals - for a worker session too, whose
 * `session_closed` only its attached connections ever see (I4).
 */
import { spawn } from "node:child_process";
import { on, once } from "node:events";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { HOST_IDLE_EXIT_MS_ENV } from "../src/modes/rpc/host-lifecycle-policy.ts";
import { HeldAnthropicModel, JsonlPeer, openedSessionId, type WireRecord } from "./helpers/rpc-generation-support.ts";
import {
	endpointScratch,
	hostArgs,
	hostEnv,
	realHost,
	sweepEndpointScratches,
	tracked,
	trackSupervisor,
} from "./helpers/rpc-host-endpoint-scratch.ts";

const IDLE_EXIT_MS = 1_000;

afterEach(sweepEndpointScratches, 180_000);

async function heldTurnScratch(label: string) {
	const held = await HeldAnthropicModel.start();
	tracked.models.push(held);
	return endpointScratch(label, held.origin);
}

async function hostWithHeldTurn(label: string) {
	const qa = await heldTurnScratch(label);
	const supervisor = await realHost(qa, qa.legacy, { idleExitMs: IDLE_EXIT_MS });
	const client = await JsonlPeer.connect(qa.legacy);
	tracked.peers.push(client);
	return { qa, supervisor, client };
}

async function clockHostWithHeldTurn(label: string, signal: AbortSignal) {
	const qa = await heldTurnScratch(label);
	const supervisor = spawn(
		process.execPath,
		// Node's built-in TypeScript handling, like `supervisorLaunch`: the host child inherits this
		// process's exec argv (`runtimeExecArgv`), and a tsx loader there slows every host boot.
		[join(import.meta.dirname, "fixtures", "rpc-lifecycle-clock.ts"), qa.legacy, qa.agentDir, ...hostArgs()],
		{
			env: {
				...process.env,
				...hostEnv(qa),
				SENPI_CODING_AGENT_DIR: qa.agentDir,
				[HOST_IDLE_EXIT_MS_ENV]: String(IDLE_EXIT_MS),
			},
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		},
	);
	if (supervisor.pid === undefined) throw new Error("clock supervisor did not spawn");
	trackSupervisor(supervisor.pid);
	let stderr = "";
	supervisor.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	// Subscribe at spawn: IPC records are buffered even while the test awaits socket I/O.
	const messages = on(supervisor, "message", { signal });
	const exited = once(supervisor, "close", { signal });
	exited.catch(() => undefined);
	onTestFinished(async () => {
		await messages.return?.();
	});
	async function message(type: string, matches: (record: WireRecord) => boolean = () => true): Promise<WireRecord> {
		const next = (async () => {
			for (;;) {
				const { value, done } = await messages.next();
				if (done) throw new Error(`clock supervisor message stream closed before ${type}`);
				const record: unknown = value[0];
				if (typeof record === "object" && record !== null && "type" in record && record.type === type) {
					const event = record as WireRecord;
					if (matches(event)) return event;
				}
			}
		})();
		return Promise.race([
			next,
			exited.then(([code, exitSignal]) => {
				throw new Error(`supervisor exited before ${type}: code=${code}, signal=${exitSignal}\n${stderr}`);
			}),
		]);
	}
	async function advance(now: number) {
		const advanced = message("clock");
		supervisor.send({ now, tick: true });
		return advanced;
	}
	await message("ready");
	const client = await JsonlPeer.connect(qa.legacy);
	tracked.peers.push(client);
	return { qa, client, message, advance, exited, stderr: () => stderr };
}

async function startHeldTurn(client: JsonlPeer, open: WireRecord): Promise<string> {
	const sessionId = openedSessionId(await client.request(open));
	const started = client.waitFor((record) => record.type === "agent_start" && record.sessionId === sessionId);
	await client.request({ id: `prompt-${sessionId}`, type: "prompt", sessionId, message: "hold this turn open" });
	await started;
	return sessionId;
}

describe.skipIf(process.platform === "win32")("idle exit after a session closed mid-turn", () => {
	for (const kind of ["worker", "interactive"] as const) {
		it(`exits because the idle deadline elapsed after a ${kind} session closed mid-turn and every client left`, async ({
			signal,
		}) => {
			const { qa, client, message, advance, exited, stderr } = await clockHostWithHeldTurn(kind.slice(0, 3), signal);
			const open = { id: "open", type: "open_session", cwd: qa.cwd, kind, retain_on_disconnect: kind === "worker" };
			const sessionId = await startHeldTurn(client, open);
			// Drain startup records and prove the held turn still prevents idle exit.
			expect(await advance(0)).toMatchObject({ shuttingDown: false, decision: "active" });
			const idle = message(
				"activity",
				(record) =>
					record.decision === "idle" &&
					(record.activity as WireRecord).connections === 0 &&
					(record.activity as WireRecord).activeTurns === 0,
			);

			await client.request({ id: "close", type: "close_session", sessionId });
			client.destroy();
			await idle;

			expect(await advance(IDLE_EXIT_MS - 1)).toMatchObject({ shuttingDown: false, decision: "idle" });
			expect(await advance(IDLE_EXIT_MS)).toMatchObject({ shuttingDown: true, decision: "exit" });
			// The existing 120 s test signal bounds shutdown; scheduler delay is not a product promise.
			expect(await exited).toEqual([0, null]);
			expect(stderr()).toContain("senpi rpc host supervisor: idle shutdown");
		}, 120_000);
	}

	it("tells an observing connection the turn settled, and still never shows it a worker's session_closed", async () => {
		const { qa, client } = await hostWithHeldTurn("obs");
		const observer = await JsonlPeer.connect(qa.legacy);
		tracked.peers.push(observer);
		const sessionId = await startHeldTurn(client, { id: "open", type: "open_session", cwd: qa.cwd, kind: "worker" });
		const settled = observer.waitFor((record) => record.type === "agent_settled" && record.sessionId === sessionId);

		await client.request({ id: "close", type: "close_session", sessionId });
		expect(await settled).toMatchObject({ reason: "session_closed" });
		// Records ahead of this response on the observer's connection have all been read once it arrives.
		await observer.request({ id: "after", type: "list_sessions" });
		expect(observer.messages.filter((record) => record.type === "session_closed")).toEqual([]);
	}, 120_000);
});
