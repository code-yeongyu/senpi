/**
 * senpi#7020 (gate 1): a socket host dies under a retained session while the ENGINE is running its turn (a peer's
 * delivery started it). The next host on the same socket reopens the session from its record, and the session goes
 * back to work by itself: a model request reaches the provider with no client connected and nothing sent. Before the
 * fix the reopen forced the session unattended, so the cut run stayed held until a person came back.
 *
 * senpi#7079: when the next host is killed too while that continuation works, the continuation goes back to work again
 * if it made progress (a completed model response or tool result), and stays held, naming the repeated restart, if not.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";
import { caseBudget, REPORT_MARGIN_MS } from "../../helpers/fixture-ready.ts";
import { type FakeModelRequest, startFakeModelServer } from "../../helpers/rpc-fake-model.ts";
import { writeRpcModelsJson } from "../../helpers/rpc-hermetic.ts";
import {
	HOLD_MARKER,
	openWithTurn,
	type OpenedSession,
	startHost,
	stopHost,
	waitListed,
} from "../../helpers/rpc-restart-retained-support.ts";
import { connectPeer, openedSessionId, scratch } from "../../helpers/rpc-socket-host-support.ts";

/**
 * Per-case timeouts, from measurement (senpi#7081). Every case starts real hosts from source, kills them and starts more.
 * On 4 cores at about 7x oversubscription (the load of a red NY2 senpi-full receipt: load_max 103 on 14 cores) the cases
 * took 82.8-85.7 s with two hosts and 89.0-111.1 s with three: at most 42.8 s for each host a case starts, against the
 * package's flat 30 s. Booting from the built bundle measured no faster, and every host here is one the case must start.
 * So a case gets HOST_SHARE_MS per host it starts, plus the margin its waits keep to report before vitest times it out;
 * each wait is bounded by what is left of that, never by a fixed window.
 */
const HOST_SHARE_MS = 45_000;
const caseTimeout = (hosts: number): number => hosts * HOST_SHARE_MS + REPORT_MARGIN_MS;
const PROGRESS_MARKER = "progress-recorded-before-the-cut";
const budget = caseBudget();

type Qa = ReturnType<typeof scratch>;
type FakeModel = Awaited<ReturnType<typeof startFakeModelServer>>;
/** What is left of the running case's budget. */
type Left = () => number;

/**
 * Runs `step` while waiting for the model request `match` takes; the request can arrive before `step` resolves.
 * The wait ends with the request, with `step`'s failure, when `step` aborts it (a host gone before the request), or
 * at the case's remaining budget. It never outlives this call, so a failed step leaves no rejection behind.
 */
async function requestDuring<T>(
	fake: FakeModel,
	label: string,
	match: (request: FakeModelRequest, index: number) => boolean,
	left: Left,
	step: (stop: AbortController) => Promise<T>,
): Promise<{ value: T; request: FakeModelRequest }> {
	const stop = new AbortController();
	try {
		const [value, request] = await Promise.all([
			step(stop),
			fake.waitForRequest(match, left(), stop.signal).catch((error: unknown) => {
				throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
			}),
		]);
		return { value, request };
	} finally {
		stop.abort(new Error(`${label}: step settled`));
	}
}

/** A host that exits while the session's next request is awaited can never send it: fail with its exit status. */
function abortOnExit(host: ChildProcessWithoutNullStreams, stop: AbortController): void {
	const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
		stop.abort(new Error(`host exited (code ${String(code)}, signal ${String(signal)}) before the request`));
	host.once("exit", onExit);
	stop.signal.addEventListener("abort", () => host.off("exit", onExit), { once: true });
}

/** A retained session whose engine-started run (a peer's delivery) the model holds open on a live host. */
async function cutEngineRun(
	qa: Qa,
	fake: FakeModel,
	text: string,
	left: Left,
): Promise<{ host: ChildProcessWithoutNullStreams; session: OpenedSession }> {
	const host = await startHost(qa);
	const opener = await connectPeer(qa.socketPath);
	try {
		const session = await openWithTurn(opener.peer, qa.cwd, "lane", left());
		await requestDuring(
			fake,
			"engine run before the cut",
			(request) => request.latest.includes(HOLD_MARKER),
			left,
			async (stop) => {
				abortOnExit(host, stop);
				const admitted = await opener.peer.request(
					{
						id: "peer-delivery",
						type: "admit_external_message",
						sessionId: session.handle,
						deliveryId: "lead-1",
						text,
						deliverAs: "followUp",
					},
					left(),
				);
				expect(admitted).toMatchObject({ success: true, data: { kind: "started" } });
			},
		);
		return { host, session };
	} finally {
		opener.socket.destroy();
	}
}

/** Restarts the host and resolves with the next model request, which only the session itself can send. */
async function restartAndAwaitRequest(
	qa: Qa,
	fake: FakeModel,
	host: ChildProcessWithoutNullStreams,
	signal: "SIGKILL" | "SIGTERM",
	left: Left,
	match: (request: FakeModelRequest) => boolean = () => true,
): Promise<{ host: ChildProcessWithoutNullStreams; request: FakeModelRequest }> {
	await stopHost(host, signal);
	const before = fake.requests.length;
	const { value, request } = await requestDuring(
		fake,
		`resumed request after ${signal}`,
		(request, index) => index >= before && match(request),
		left,
		async (stop) => {
			const restarted = await startHost(qa);
			abortOnExit(restarted, stop);
			return restarted;
		},
	);
	return { host: value, request };
}

describe.skipIf(process.platform === "win32")("an engine run cut by a host restart (senpi#7020)", () => {
	// The host-exit bound itself: a host killed while its request is awaited ends the wait with the exit, not with the
	// budget's "no model request matched".
	it(
		"fails a request wait at once, naming the exit, when its host dies first",
		async () => {
			const qa = scratch("host-gone");
			const fake = await startFakeModelServer();
			writeRpcModelsJson(qa.agentDir, fake.origin);
			const left = (): number => budget(caseTimeout(1));
			try {
				const host = await startHost(qa);
				const waited = requestDuring(
					fake,
					"request on a killed host",
					() => true,
					left,
					async (stop) => {
						abortOnExit(host, stop);
						await stopHost(host, "SIGKILL");
					},
				);
				await expect(waited).rejects.toThrow(
					"request on a killed host: host exited (code null, signal SIGKILL) before the request",
				);
			} finally {
				await fake.close();
			}
		},
		caseTimeout(1),
	);

	it.each(["SIGKILL", "SIGTERM"] as const)(
		"resumes on the next host with no client input after %s",
		async (signal) => {
			const left = (): number => budget(caseTimeout(2));
			const qa = scratch(`resume-${signal.toLowerCase()}`);
			const fake = await startFakeModelServer({ holdOnLastMessage: HOLD_MARKER });
			writeRpcModelsJson(qa.agentDir, fake.origin);
			try {
				const { host } = await cutEngineRun(qa, fake, `[from lead] ${HOLD_MARKER}`, left);
				// The restarted host gets no connection and no input: whatever reaches the model now, the session sent.
				const { request } = await restartAndAwaitRequest(qa, fake, host, signal, left);
				expect(request.latest).not.toContain(HOLD_MARKER);
			} finally {
				await fake.close();
			}
		},
		caseTimeout(2),
	);

	it(
		"resumes again after a second kill when the resumed run made progress (senpi#7079)",
		async () => {
			const qa = scratch("resume-twice");
			const left = (): number => budget(caseTimeout(3));
			writeFileSync(join(qa.cwd, "probe.txt"), `${PROGRESS_MARKER}\n`);
			// The resumed run reads probe.txt (a completed model response and a tool result), then its next request stays open.
			const fake = await startFakeModelServer({
				holdWhen: (request) =>
					request.latest.includes(HOLD_MARKER) || request.latestToolResult.includes(PROGRESS_MARKER),
			});
			writeRpcModelsJson(qa.agentDir, fake.origin);
			try {
				const { host } = await cutEngineRun(qa, fake, `[from lead] tool-call-read ${HOLD_MARKER}`, left);
				const progressed = await restartAndAwaitRequest(qa, fake, host, "SIGKILL", left, (request) =>
					request.latestToolResult.includes(PROGRESS_MARKER),
				);
				const { request } = await restartAndAwaitRequest(qa, fake, progressed.host, "SIGKILL", left);
				expect(request.latest).not.toContain(HOLD_MARKER);
			} finally {
				await fake.close();
			}
		},
		caseTimeout(3),
	);

	it(
		"stays held, naming the repeated restart, after a second kill before the resumed run made progress (senpi#7079)",
		async () => {
			const qa = scratch("resume-no-progress");
			const left = (): number => budget(caseTimeout(3));
			// Once the run is cut, every request stays open: the resumed run records no progress.
			let cutDone = false;
			const fake = await startFakeModelServer({
				holdWhen: (request) => cutDone || request.latest.includes(HOLD_MARKER),
			});
			writeRpcModelsJson(qa.agentDir, fake.origin);
			try {
				const { host, session } = await cutEngineRun(qa, fake, `[from lead] ${HOLD_MARKER}`, left);
				cutDone = true;
				const resumed = await restartAndAwaitRequest(qa, fake, host, "SIGKILL", left);
				await stopHost(resumed.host, "SIGKILL");
				await startHost(qa);
				const viewer = await connectPeer(qa.socketPath);
				try {
					await waitListed(viewer.peer, [session.durableId], left());
					const attached = await viewer.peer.request(
						{ id: "attach", type: "open_session", sessionPath: session.sessionFile, retain_on_disconnect: true },
						left(),
					);
					const state = await viewer.peer.request(
						{ id: "state", type: "get_state", sessionId: openedSessionId(attached) },
						left(),
					);
					const holds = (state.data as { holds: { key: string; data?: unknown }[] }).holds;
					expect(holds.map(({ key, data }) => ({ key, data }))).toEqual([
						{ key: "interrupted-run", data: { reason: "repeated_restart_no_progress" } },
					]);
				} finally {
					viewer.socket.destroy();
				}
			} finally {
				await fake.close();
			}
		},
		caseTimeout(3),
	);
});
