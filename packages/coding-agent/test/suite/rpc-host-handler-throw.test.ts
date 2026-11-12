/**
 * senpi#6483: a host-level command whose handler throws is still answered. The multi-session host caught such a
 * line's rejection by writing one line to its stderr and sent nothing, so the caller waited out its own timeout.
 * Only session-scoped commands were answered when they threw.
 *
 * Runs on the bare host's per-connection dispatch over a real socket (`rpc-delegated-host-support.ts`). The handler
 * is made to throw through the router's own public surface: `list_sessions` reads the host's memory view for every
 * row, and the view is one a test may set.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type DelegatedHost, openSession, type Peer, startHost } from "./rpc-delegated-host-support.ts";

const FAILURE = "the heap view failed";

describe("a host-level command whose handler throws is still answered (senpi#6483)", () => {
	let host: DelegatedHost;
	let peer: Peer;

	beforeAll(async () => {
		host = await startHost();
		peer = await host.proven();
		// One hosted session, so `list_sessions` has a row to read the memory view for.
		await openSession(peer);
	}, 60_000);
	afterEach(() => {
		host.core.router.setHostMemoryView({ mainHeapBytes: () => 0, kernels: () => [] });
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await host.dispose();
	}, 60_000);

	const failingView = () =>
		host.core.router.setHostMemoryView({
			mainHeapBytes: () => {
				throw new Error(FAILURE);
			},
			kernels: () => [],
		});
	const stderrLines = () => {
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		return () => spy.mock.calls.map((call) => String(call[0]));
	};

	it("#given a list_sessions whose handler throws #when it is sent over a socket connection #then it is answered success: false with its command and the failure, before the next request's answer, and the host says so on stderr", async () => {
		const written = stderrLines();
		failingView();

		// Resolves with the answer only if one arrives before the answer to a request sent right behind it.
		const answer = await peer.sendSettled({ type: "list_sessions" });

		expect(answer).toMatchObject({
			type: "response",
			command: "list_sessions",
			success: false,
			error: "internal_error",
			errorCode: "internal_error",
			errorData: { detail: FAILURE },
		});
		expect(written()).toContain(`senpi rpc connection ${peer.connectionId} failed: ${FAILURE}\n`);
	});

	it("#given that failure was answered #when the same command is sent again with the handler healthy #then the connection answers it as before", async () => {
		failingView();
		await peer.sendSettled({ type: "list_sessions" });
		host.core.router.setHostMemoryView({ mainHeapBytes: () => 0, kernels: () => [] });

		const answer = await peer.send({ type: "list_sessions" });

		expect(answer).toMatchObject({ success: true, data: { sessions: [expect.any(Object)] } });
	});

	it("#given no connection, as on the stdio transport #when a list_sessions line's handler throws #then the line's handling settles and the host reports it as a stdio request", async () => {
		const written = stderrLines();
		failingView();

		await expect(host.core.handle(JSON.stringify({ id: "stdio-1", type: "list_sessions" }))).resolves.toBeUndefined();

		expect(written()).toContain(`senpi rpc stdio request failed: ${FAILURE}\n`);
	});
});
