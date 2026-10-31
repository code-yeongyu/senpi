import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import type { RpcSessionEntry } from "../../../src/modes/rpc/session-registry.ts";
import { SessionWorkerClient } from "../../../src/modes/rpc/session-worker-client.ts";
import { createInProcessRig } from "../rpc-inprocess-host-support.ts";
import { workerAcceptanceHost } from "./4272-worker-acceptance-support.ts";

const FLAG = "SENPI_ENGINE_SOCKET_COMPACT_UPDATES";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Both registries mint `rpc-<n>`; each test opens exactly one session. */
const HANDLE = "rpc-1";

type Step = {
	readonly step: "bootstrap" | "commit" | "admission" | "reply";
	readonly state: RpcSessionEntry["state"] | undefined;
	readonly sessionEpoch: string | undefined;
	readonly sequence: number | undefined;
};

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

function observeOpen(
	peek: (handle: string) => RpcSessionEntry | undefined,
	lane: () => SessionAcceptanceLane | undefined,
) {
	const steps: Step[] = [];
	const record = (step: Step["step"], from = lane()) => {
		const root = from?.freeze();
		if (from && root) from.release(root);
		steps.push({ step, state: peek(HANDLE)?.state, sessionEpoch: root?.sessionEpoch, sequence: root?.sequence });
	};
	const bootstrap = SessionAcceptanceLane.prototype.bootstrap;
	vi.spyOn(SessionAcceptanceLane.prototype, "bootstrap").mockImplementation(function (
		this: SessionAcceptanceLane,
		input,
	) {
		bootstrap.call(this, input);
		record("bootstrap", this);
	});
	const attach = SessionEventWriter.prototype.attachConnectionToSession;
	vi.spyOn(SessionEventWriter.prototype, "attachConnectionToSession").mockImplementation(function (
		this: SessionEventWriter,
		id: string,
		sessionId: string,
	) {
		record("admission");
		attach.call(this, id, sessionId);
	});
	return { steps, record };
}

function expectOneBaseline(steps: readonly Step[]): void {
	const epoch = steps[0]?.sessionEpoch;
	expect(epoch).toMatch(UUID);
	expect(
		steps.every((step) => step.sessionEpoch === epoch),
		"one baseline, before every later step",
	).toBe(true);
	expect(steps.filter((step) => step.step !== "reply").every((step) => step.sequence === 0)).toBe(true);
}

// Part of #4272, ruling 10: the accepted baseline exists before the entry opens, before admission and reply.
it("bootstrap before admission, in-process: accepted while the entry is opening, before router admission and the open reply", async () => {
	vi.stubEnv(FLAG, "1");
	const dir = await mkdtemp(join(tmpdir(), "senpi-4272-admission-"));
	const rig = createInProcessRig(dir);
	const { steps, record } = observeOpen(
		(handle) => rig.registry.peek(handle),
		() => rig.registry.peek(HANDLE)?.acceptance,
	);
	try {
		const opened = await rig.open("caller", { cwd: dir, sessionPath: join(dir, "session.jsonl") });
		expect(opened?.success, JSON.stringify(opened)).toBe(true);
		record("reply");
		expect(steps.map(({ step, state }) => [step, state])).toEqual([
			["bootstrap", "opening"],
			["admission", "open"],
			["reply", "open"],
		]);
		expectOneBaseline(steps);
	} finally {
		rig.teardown.release();
		await rig[Symbol.asyncDispose]();
		await rm(dir, { recursive: true, force: true });
	}
}, 60_000);

it("bootstrap before admission, worker: accepted from 'ready' inside commit, before the entry opens, admission and the open reply", async () => {
	vi.stubEnv(FLAG, "1");
	const host = await workerAcceptanceHost();
	const worker = () => host.registry.peek(HANDLE)?.worker?.acceptance;
	const { steps, record } = observeOpen((handle) => host.registry.peek(handle), worker);
	const commit = SessionWorkerClient.prototype.commit;
	vi.spyOn(SessionWorkerClient.prototype, "commit").mockImplementation(async function (this: SessionWorkerClient) {
		const snapshot = await commit.call(this);
		record("commit", this.acceptance);
		return snapshot;
	});
	const replied = host.next("open reply", (wire) => {
		const reply = wire.type === "response" && wire.command === "open_session";
		if (reply) record("reply");
		return reply;
	});
	try {
		await host.open();
		await replied;
		expect(steps.map(({ step, state }) => [step, state])).toEqual([
			["bootstrap", "opening"],
			["commit", "opening"],
			["admission", "open"],
			["reply", "open"],
		]);
		expectOneBaseline(steps);
	} finally {
		await host.dispose();
	}
}, 60_000);
