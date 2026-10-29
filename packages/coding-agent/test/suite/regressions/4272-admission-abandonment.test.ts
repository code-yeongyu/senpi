import { afterEach, expect, it, vi } from "vitest";
import { setTimeout as deadline, clearTimeout as clearDeadline } from "node:timers";
import { setImmediate as nextTurn } from "node:timers/promises";
import { CompactAdmissions } from "../../../src/modes/rpc/compact-admissions.ts";
import { OPEN_AFTER_QUEUED_DEADLINE_MS } from "../../../src/modes/rpc/rpc-request-deadline.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { statusHost } from "../rpc-session-status-support.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

// A failure guard on the exact teardown promise, not a delay used to make progress.
function bounded<T>(pending: Promise<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = deadline(() => reject(new Error("teardown did not settle after the controlled deadline")), 10_000);
		void pending.then(
			(value) => {
				clearDeadline(timer);
				resolve(value);
			},
			(cause: unknown) => {
				clearDeadline(timer);
				reject(cause);
			},
		);
	});
}
// #4272 RULING-89 Q2: the producer remains blocked past the existing open deadline.
// The test releases the gate only for RED cleanup, never to make the assertion succeed.
it.each(["forgetPeer", "dispose"] as const)(
	"T2/X04 %s bounds a producer that never settles during teardown",
	async (operation) => {
		const index = new CompactAdmissions();
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const release = vi.fn(async () => {});
		const answer = vi.fn();
		const pending = index.run(
			{ socketEpoch: "epoch", peer: "peer", admissionId: "held", fingerprint: "a".repeat(64) },
			async () => {
				entered.resolve();
				await finish.promise;
				return { answer: {}, release };
			},
		);
		void pending.then(answer, () => {});
		await entered.promise;
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let ended = false;
		const ending = (operation === "forgetPeer" ? index.forgetPeer("epoch") : index.dispose()).then(() => {
			ended = true;
		});
		try {
			await vi.advanceTimersByTimeAsync(OPEN_AFTER_QUEUED_DEADLINE_MS);
			await bounded(ending);
			expect(ended, "epoch teardown must not wait forever for a lost producer").toBe(true);
			expect(index.status().abandoned).toBe(1);
			finish.resolve();
			await nextTurn();
			expect(release, "RULING-90: release a successful result after the abort").toHaveBeenCalledTimes(1);
			expect(answer).not.toHaveBeenCalled();
			expect(await index.result("epoch", "held")).toBeUndefined();
			expect(index.status().abandoned).toBe(1);
		} finally {
			finish.resolve();
			await Promise.allSettled([pending, ending]);
			await index.dispose();
		}
	},
);

it.each(["connection release", "host dispose"] as const)(
	"T2/X04 %s finishes while physical open remains held",
	async (operation) => {
		vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
		const host = await statusHost();
		const peer = host.client("peer");
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const closed = Promise.withResolvers<void>();
		const close = RpcSessionRegistry.prototype.close;
		const closeSession = vi.spyOn(RpcSessionRegistry.prototype, "close").mockImplementation(async function (
			this: RpcSessionRegistry,
			...args
		) {
			try {
				return await close.apply(this, args);
			} finally {
				closed.resolve();
			}
		});
		const open = RpcSessionRegistry.prototype.openSession;
		vi.spyOn(RpcSessionRegistry.prototype, "openSession").mockImplementationOnce(async function (
			this: RpcSessionRegistry,
			...args
		) {
			entered.resolve();
			await finish.promise;
			return open.apply(this, args);
		});
		const pending = host.writer.withConnection("peer", () =>
			host.core.handle(
				JSON.stringify({
					id: "held",
					type: "open_session",
					cwd: host.cwd,
					admissionId: "held",
				}),
			),
		);
		void pending.catch(() => {});
		await entered.promise;
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let ended = false;
		const ending = (operation === "connection release" ? host.drop("peer") : host.core.router.dispose()).then(() => {
			ended = true;
		});
		try {
			await vi.advanceTimersByTimeAsync(OPEN_AFTER_QUEUED_DEADLINE_MS);
			await bounded(ending);
			expect(ended, "public teardown must observe the bounded admission producer").toBe(true);
			vi.useRealTimers();
			finish.resolve();
			await bounded(closed.promise);
			await nextTurn();
			expect(closeSession).toHaveBeenCalledTimes(1);
			expect(host.core.router.sessionCount).toBe(0);
			expect(peer.inbox.some((record) => record.type === "session_opened")).toBe(false);
			expect(peer.inbox.some((record) => record.type === "response" && record.success === true)).toBe(false);
		} finally {
			vi.useRealTimers();
			finish.resolve();
			await Promise.allSettled([pending, ending]);
			await host[Symbol.asyncDispose]();
		}
	},
	120_000,
);

it("RULING-90 swallows a producer rejection after the deadline without publishing an answer", async () => {
	const index = new CompactAdmissions();
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<never>();
	const unhandled = vi.fn();
	const answer = vi.fn();
	process.on("unhandledRejection", unhandled);
	const pending = index.run(
		{ socketEpoch: "epoch", peer: "peer", admissionId: "held", fingerprint: "a".repeat(64) },
		() => {
			entered.resolve();
			return finish.promise;
		},
	);
	void pending.then(answer, () => {});
	await entered.promise;
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const ending = index.forgetPeer("epoch");
	try {
		await vi.advanceTimersByTimeAsync(OPEN_AFTER_QUEUED_DEADLINE_MS);
		await bounded(ending);
		finish.reject(new Error("late producer failure"));
		await nextTurn();
		expect(unhandled).not.toHaveBeenCalled();
		expect(answer).not.toHaveBeenCalled();
		expect(await index.result("epoch", "held")).toBeUndefined();
		expect(index.status().abandoned).toBe(1);
	} finally {
		finish.reject(new Error("cleanup"));
		await Promise.allSettled([pending, ending]);
		await index.dispose();
		process.off("unhandledRejection", unhandled);
	}
});

it.each(["forgetPeer", "forgetConnection", "dispose"] as const)(
	"RULING-90 %s unrefs the epoch deadline and clears it on normal close",
	async (operation) => {
		const index = new CompactAdmissions();
		await index.run(
			{ socketEpoch: "epoch", peer: "peer", admissionId: "done", fingerprint: "a".repeat(64) },
			async () => ({ answer: {}, release: async () => {} }),
		);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const timers = vi.spyOn(globalThis, "setTimeout");
		index.endConnection("peer");
		try {
			expect(timers.mock.results[0]?.value.hasRef()).toBe(false);
		} finally {
			if (operation === "forgetPeer") await index.forgetPeer("epoch");
			else if (operation === "forgetConnection") await index.forgetConnection("peer");
			else await index.dispose();
		}
		expect(vi.getTimerCount()).toBe(0);
		await index.dispose();
	},
);
