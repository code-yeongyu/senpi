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
 * Each step's bound, inside the test's timeout: a session that never resumes fails here, named. A step includes a real
 * host start, which took over 20 s on a loaded machine (the cases timed out in a parallel scope run at load 50).
 */
const STEP_MS = 60_000;
const RESTART_MS = 150_000;
/** Three real host starts run in the repeated-restart cases. */
const REPEATED_RESTART_MS = 240_000;
const PROGRESS_MARKER = "progress-recorded-before-the-cut";

type Qa = ReturnType<typeof scratch>;

/** A retained session whose engine-started run (a peer's delivery) the model holds open on a live host. */
async function cutEngineRun(
	qa: Qa,
	fake: Awaited<ReturnType<typeof startFakeModelServer>>,
	text: string,
): Promise<{ host: ChildProcessWithoutNullStreams; session: OpenedSession }> {
	const host = await startHost(qa);
	const opener = await connectPeer(qa.socketPath);
	try {
		const session = await openWithTurn(opener.peer, qa.cwd, "lane");
		const cut = fake.waitForRequest((request) => request.latest.includes(HOLD_MARKER), STEP_MS);
		const admitted = await opener.peer.request({
			id: "peer-delivery",
			type: "admit_external_message",
			sessionId: session.handle,
			deliveryId: "lead-1",
			text,
			deliverAs: "followUp",
		});
		expect(admitted).toMatchObject({ success: true, data: { kind: "started" } });
		await cut;
		return { host, session };
	} finally {
		opener.socket.destroy();
	}
}

/** Restarts the host and resolves with the next model request, which only the session itself can send. */
async function restartAndAwaitRequest(
	qa: Qa,
	fake: Awaited<ReturnType<typeof startFakeModelServer>>,
	host: ChildProcessWithoutNullStreams,
	signal: "SIGKILL" | "SIGTERM",
	match: (request: FakeModelRequest) => boolean = () => true,
): Promise<{ host: ChildProcessWithoutNullStreams; request: FakeModelRequest }> {
	await stopHost(host, signal);
	const before = fake.requests.length;
	const next = fake.waitForRequest((request, index) => index >= before && match(request), STEP_MS);
	const restarted = await startHost(qa);
	return { host: restarted, request: await next };
}

describe.skipIf(process.platform === "win32")("an engine run cut by a host restart (senpi#7020)", () => {
	it.each(["SIGKILL", "SIGTERM"] as const)(
		"resumes on the next host with no client input after %s",
		async (signal) => {
			const qa = scratch(`resume-${signal.toLowerCase()}`);
			const fake = await startFakeModelServer({ holdOnLastMessage: HOLD_MARKER });
			writeRpcModelsJson(qa.agentDir, fake.origin);
			try {
				const { host } = await cutEngineRun(qa, fake, `[from lead] ${HOLD_MARKER}`);
				// The restarted host gets no connection and no input: whatever reaches the model now, the session sent.
				const { request } = await restartAndAwaitRequest(qa, fake, host, signal);
				expect(request.latest).not.toContain(HOLD_MARKER);
			} finally {
				await fake.close();
			}
		},
		RESTART_MS,
	);

	it(
		"resumes again after a second kill when the resumed run made progress (senpi#7079)",
		async () => {
			const qa = scratch("resume-twice");
			writeFileSync(join(qa.cwd, "probe.txt"), `${PROGRESS_MARKER}\n`);
			// The resumed run reads probe.txt (a completed model response and a tool result), then its next request stays open.
			const fake = await startFakeModelServer({
				holdWhen: (request) =>
					request.latest.includes(HOLD_MARKER) || request.latestToolResult.includes(PROGRESS_MARKER),
			});
			writeRpcModelsJson(qa.agentDir, fake.origin);
			try {
				const { host } = await cutEngineRun(qa, fake, `[from lead] tool-call-read ${HOLD_MARKER}`);
				const progressed = await restartAndAwaitRequest(qa, fake, host, "SIGKILL", (request) =>
					request.latestToolResult.includes(PROGRESS_MARKER),
				);
				const { request } = await restartAndAwaitRequest(qa, fake, progressed.host, "SIGKILL");
				expect(request.latest).not.toContain(HOLD_MARKER);
			} finally {
				await fake.close();
			}
		},
		REPEATED_RESTART_MS,
	);

	it(
		"stays held, naming the repeated restart, after a second kill before the resumed run made progress (senpi#7079)",
		async () => {
			const qa = scratch("resume-no-progress");
			// Once the run is cut, every request stays open: the resumed run records no progress.
			let cutDone = false;
			const fake = await startFakeModelServer({
				holdWhen: (request) => cutDone || request.latest.includes(HOLD_MARKER),
			});
			writeRpcModelsJson(qa.agentDir, fake.origin);
			try {
				const { host, session } = await cutEngineRun(qa, fake, `[from lead] ${HOLD_MARKER}`);
				cutDone = true;
				const resumed = await restartAndAwaitRequest(qa, fake, host, "SIGKILL");
				await stopHost(resumed.host, "SIGKILL");
				await startHost(qa);
				const viewer = await connectPeer(qa.socketPath);
				try {
					await waitListed(viewer.peer, [session.durableId]);
					const attached = await viewer.peer.request({
						id: "attach",
						type: "open_session",
						sessionPath: session.sessionFile,
						retain_on_disconnect: true,
					});
					const state = await viewer.peer.request({
						id: "state",
						type: "get_state",
						sessionId: openedSessionId(attached),
					});
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
		REPEATED_RESTART_MS,
	);
});
