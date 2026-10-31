import { afterEach, expect, it, vi } from "vitest";
import { StructuredLaneUnavailableError } from "../../../src/core/structured-session-lane.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { SessionWorkerClient } from "../../../src/modes/rpc/session-worker-client.ts";
import { hostWorkerPermits } from "../../../src/modes/rpc/session-worker-permits.ts";

const commitReply = vi.hoisted(() => ({ bootstrap: false }));

vi.mock("node:worker_threads", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:worker_threads")>();
	const { EventEmitter: Emitter } = await import("node:events");
	return {
		...actual,
		Worker: class extends Emitter {
			postMessage(message: { type: string; request?: number }): void {
				const request = message.request;
				if (typeof request !== "number") return;
				const reply =
					message.type === "commit"
						? {
								type: "ready",
								request,
								snapshot: { state: {}, liveSessionPaths: [], busy: false, streaming: false },
								...(commitReply.bootstrap ? { bootstrap: { transcript: [] } } : {}),
							}
						: { type: "result", request };
				queueMicrotask(() => this.emit("message", reply));
			}
			terminate(): Promise<number> {
				this.emit("exit", 0);
				return Promise.resolve(0);
			}
		},
	};
});

const FLAG = "SENPI_ENGINE_SOCKET_COMPACT_UPDATES";
let client: SessionWorkerClient | undefined;

afterEach(async () => {
	client?.quarantine();
	await client?.exited;
	client = undefined;
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

function worker() {
	const delivered: string[] = [];
	const failures: string[] = [];
	const writer = new SessionEventWriter(() => {});
	writer.registerConnection("client", {
		writeRaw: (line) => delivered.push(line),
		waitForBackpressure: async () => {},
	});
	writer.attachConnectionToSession("client", "session");
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	client = new SessionWorkerClient({
		reserve: () => "granted",
		reconcile: () => {},
		exit: () => {},
		failure: (error) => failures.push(error),
	});
	const boundModes = () => stderr.mock.calls.flatMap(([chunk]) => String(chunk).match(/bound mode=(\w+)/)?.[1] ?? []);
	return { client, writer, delivered, failures, boundModes };
}

// Part of #4272, RULING-106 (B'): commit() alone negotiates acceptance, one outcome per branch, and the client logs the
// mode each worker bound. A declined offer leaves no permit behind in the host's shared ledger.
it.each([
	{ bootstrap: true, flag: "0", mode: "acceptance" },
	{ bootstrap: false, flag: "0", mode: "legacy" },
	{ bootstrap: false, flag: "1", mode: "refused" },
])("commit with bootstrap=$bootstrap and flag=$flag binds $mode", async ({ bootstrap, flag, mode }) => {
	vi.stubEnv(FLAG, flag);
	commitReply.bootstrap = bootstrap;
	const permitsBefore = hostWorkerPermits.status();
	const host = worker();

	const committed = host.client.commit();

	if (mode === "refused") {
		const refusal = committed.catch((error: unknown) => error);
		expect(await refusal).toBeInstanceOf(StructuredLaneUnavailableError);
		expect(String(await refusal)).toContain(
			"construct the session via the session layer, or turn the engine-socket compact-updates flag off",
		);
		expect(host.client.acceptance).toBeUndefined();
		expect(hostWorkerPermits.status()).toEqual(permitsBefore);
		return;
	}
	await committed;
	await host.client.bind("session", host.writer, () => {}, { capabilities: [] });
	expect(host.boundModes()).toEqual([mode]);
	expect(host.client.acceptance !== undefined).toBe(mode === "acceptance");
	if (mode === "legacy") expect(hostWorkerPermits.status()).toEqual(permitsBefore);
});

it("delivers unordered output frames before commit() negotiates acceptance", async () => {
	const host = worker();
	await host.client.bind("session", host.writer, () => {}, { capabilities: [] });

	host.client.worker.emit("message", {
		type: "output",
		record: { type: "agent_start", sessionId: "session" },
		signal: new SharedArrayBuffer(4),
		activity: { busy: false, handoffBusy: false, streaming: false },
	});
	await host.writer.flush();

	expect(host.failures).toEqual([]);
	expect(host.boundModes()).toEqual(["legacy"]);
	expect(host.delivered.map((line) => JSON.parse(line))).toContainEqual(
		expect.objectContaining({ type: "agent_start" }),
	);
});
