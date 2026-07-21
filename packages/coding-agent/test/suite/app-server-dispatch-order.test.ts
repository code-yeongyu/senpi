import { describe, expect, it } from "vitest";
import type { RpcEnvelope } from "../../src/modes/app-server/rpc/envelope.ts";
import { ServerCore } from "../../src/modes/app-server/server/server-core.ts";

describe("app-server post-response dispatch", () => {
	it("writes the response before a request-scoped deferred notification", async () => {
		// Given: an initialized connection whose next response write is controllable.
		const frames: RpcEnvelope[] = [];
		let holdResponse = false;
		let releaseResponse = (): void => undefined;
		let responseWriteStarted = (): void => undefined;
		const responseReleased = new Promise<void>((resolve) => {
			releaseResponse = resolve;
		});
		const responseStarted = new Promise<void>((resolve) => {
			responseWriteStarted = resolve;
		});
		const core = new ServerCore({ codexHome: "/tmp/task7-dispatch", now: () => 1_900_000_021 });
		const connectionId = core.addConnection({
			id: "dispatch-order",
			transportKind: "stdio",
			send: (frame) => {
				frames.push(frame);
				if (holdResponse && "id" in frame) {
					responseWriteStarted();
					return responseReleased;
				}
			},
			close: () => undefined,
		}).id;
		await initialize(core, connectionId);
		frames.length = 0;
		core.registerMethod("test/deferred", {
			handler: () => {
				const accepted = core.deferUntilResponded(connectionId, async () => {
					await core.sendNotificationToConnection(connectionId, {
						method: "thread/started",
						params: { thread: { id: "thread-1" } },
					});
				});
				expect(accepted).toBe(true);
				return { accepted: true };
			},
		});

		// When: dispatch reaches the response write, but the write has not completed.
		holdResponse = true;
		const receive = core.receive(connectionId, {
			kind: "request",
			message: { id: 2, method: "test/deferred", params: {} },
		});
		await responseStarted;

		// Then: the notification waits for the successful response write.
		expect(frames).toEqual([{ id: 2, result: { accepted: true } }]);
		holdResponse = false;
		releaseResponse();
		await receive;
		expect(frames).toEqual([
			{ id: 2, result: { accepted: true } },
			{
				method: "thread/started",
				params: { thread: { id: "thread-1" } },
				emittedAtMs: 1_900_000_021,
			},
		]);
	});

	it("rejects deferral outside the active request and discards actions on handler failure", async () => {
		// Given: an initialized connection and a failing handler that tries to defer.
		const frames: RpcEnvelope[] = [];
		const actions: string[] = [];
		const core = new ServerCore({ codexHome: "/tmp/task7-dispatch-errors" });
		const connectionId = core.addConnection({
			id: "dispatch-errors",
			transportKind: "stdio",
			send: (frame) => void frames.push(frame),
			close: () => undefined,
		}).id;
		await initialize(core, connectionId);
		frames.length = 0;
		expect(core.deferUntilResponded(connectionId, () => void actions.push("outside"))).toBe(false);
		core.registerMethod("test/failing-deferred", {
			handler: () => {
				core.deferUntilResponded(connectionId, () => void actions.push("handler"));
				throw new Error("handler failed");
			},
		});

		// When: the handler fails and the JSON-RPC error response is written.
		await core.receive(connectionId, {
			kind: "request",
			message: { id: 3, method: "test/failing-deferred", params: {} },
		});

		// Then: neither the out-of-scope nor failed-request action executes.
		expect(frames).toEqual([{ id: 3, error: { code: -32603, message: "handler failed" } }]);
		expect(actions).toEqual([]);
	});

	it("isolates concurrent deferred actions on the same connection", async () => {
		// Given: two overlapping requests whose handlers and responses finish in reverse order.
		const frames: RpcEnvelope[] = [];
		const actions: string[] = [];
		const startedA = deferred();
		const startedB = deferred();
		const releaseA = deferred();
		const releaseB = deferred();
		const core = new ServerCore({ codexHome: "/tmp/task7-dispatch-isolation" });
		const connectionId = core.addConnection({
			id: "dispatch-isolation",
			transportKind: "websocket",
			send: (frame) => void frames.push(frame),
			close: () => undefined,
		}).id;
		await initialize(core, connectionId);
		frames.length = 0;
		core.registerMethod("test/deferred-isolation", {
			handler: async ({ request }) => {
				const isA = request.id === 10;
				const label = isA ? "A" : "B";
				const accepted = core.deferUntilResponded(connectionId, () => void actions.push(`defer-${label}`));
				expect(accepted).toBe(true);
				if (isA) {
					startedA.resolve();
					await releaseA.promise;
				} else {
					startedB.resolve();
					await releaseB.promise;
				}
				return { label };
			},
		});

		// When: both dispatches are active, then B and A are released in that order.
		const receiveA = core.receive(connectionId, {
			kind: "request",
			message: { id: 10, method: "test/deferred-isolation", params: {} },
		});
		const receiveB = core.receive(connectionId, {
			kind: "request",
			message: { id: 11, method: "test/deferred-isolation", params: {} },
		});
		await Promise.all([startedA.promise, startedB.promise]);
		releaseB.resolve();
		await receiveB;
		releaseA.resolve();
		await receiveA;

		// Then: each request keeps its own action and executes it immediately after its own response.
		expect(frames).toEqual([
			{ id: 11, result: { label: "B" } },
			{ id: 10, result: { label: "A" } },
		]);
		expect(actions).toEqual(["defer-B", "defer-A"]);
	});

	it("drops deferred actions when writing the response fails", async () => {
		// Given: a connection whose request response write rejects after the handler defers an action.
		const actions: string[] = [];
		let rejectResponse = false;
		const core = new ServerCore({ codexHome: "/tmp/task7-dispatch-write-failure" });
		const connectionId = core.addConnection({
			id: "dispatch-write-failure",
			transportKind: "unix",
			send: (frame) => {
				if (rejectResponse && "id" in frame && frame.id === 20) {
					return Promise.reject(new Error("response write failed"));
				}
			},
			close: () => undefined,
		}).id;
		await initialize(core, connectionId);
		core.registerMethod("test/deferred-write-failure", {
			handler: () => {
				core.deferUntilResponded(connectionId, () => void actions.push("should-not-run"));
				return { accepted: true };
			},
		});

		// When: the response write rejects.
		rejectResponse = true;
		await expect(
			core.receive(connectionId, {
				kind: "request",
				message: { id: 20, method: "test/deferred-write-failure", params: {} },
			}),
		).rejects.toThrow("response write failed");

		// Then: the deferred side effect is discarded.
		expect(actions).toEqual([]);
	});

	it("drops deferred actions when the connection disconnects during response write", async () => {
		// Given: a response write held open while a deferred action is pending.
		const actions: string[] = [];
		const responseStarted = deferred();
		const releaseResponse = deferred();
		let holdResponse = false;
		const core = new ServerCore({ codexHome: "/tmp/task7-dispatch-disconnect" });
		const connectionId = core.addConnection({
			id: "dispatch-disconnect",
			transportKind: "websocket",
			send: (frame) => {
				if (holdResponse && "id" in frame && frame.id === 30) {
					responseStarted.resolve();
					return releaseResponse.promise;
				}
			},
			close: () => undefined,
		}).id;
		await initialize(core, connectionId);
		core.registerMethod("test/deferred-disconnect", {
			handler: () => {
				core.deferUntilResponded(connectionId, () => void actions.push("should-not-run"));
				return { accepted: true };
			},
		});

		// When: the transport disconnects before the response write completes.
		holdResponse = true;
		const receive = core.receive(connectionId, {
			kind: "request",
			message: { id: 30, method: "test/deferred-disconnect", params: {} },
		});
		await responseStarted.promise;
		core.removeConnection(connectionId);
		releaseResponse.resolve();
		await receive;

		// Then: the action is discarded even though the write promise eventually resolves.
		expect(actions).toEqual([]);
	});

	it("stamps a direct ServerCore broadcast once before fanout", async () => {
		// Given: two initialized connections and a counting emission clock.
		const first: RpcEnvelope[] = [];
		const second: RpcEnvelope[] = [];
		let clockCalls = 0;
		const core = new ServerCore({
			codexHome: "/tmp/task7-direct-broadcast",
			now: () => {
				clockCalls += 1;
				return 1_900_000_031;
			},
		});
		const firstId = core.addConnection({
			id: "broadcast-first",
			transportKind: "stdio",
			send: (frame) => void first.push(frame),
			close: () => undefined,
		}).id;
		const secondId = core.addConnection({
			id: "broadcast-second",
			transportKind: "unix",
			send: (frame) => void second.push(frame),
			close: () => undefined,
		}).id;
		await initialize(core, firstId);
		await initialize(core, secondId);
		first.length = 0;
		second.length = 0;

		// When: one notification is broadcast through ServerCore's direct path.
		const delivered = await core.broadcastNotification({
			method: "thread/started",
			params: { thread: { id: "thread-1" } },
		});

		// Then: both connections see one shared timestamp and the clock ran once.
		expect(delivered).toBe(2);
		expect(first).toEqual([
			{
				method: "thread/started",
				params: { thread: { id: "thread-1" } },
				emittedAtMs: 1_900_000_031,
			},
		]);
		expect(second).toEqual(first);
		expect(clockCalls).toBe(1);
	});
});

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

async function initialize(core: ServerCore, connectionId: string): Promise<void> {
	await core.receive(connectionId, {
		kind: "request",
		message: {
			id: 1,
			method: "initialize",
			params: {
				clientInfo: { name: "task7", title: "Task 7", version: "0.0.1" },
				capabilities: { experimentalApi: true, requestAttestation: false },
			},
		},
	});
}
