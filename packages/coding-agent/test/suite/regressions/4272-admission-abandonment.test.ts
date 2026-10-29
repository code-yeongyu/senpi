import { afterEach, expect, it, vi } from "vitest";
import { setTimeout as deadline, clearTimeout as clearDeadline } from "node:timers";
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
		const pending = index.run(
			{ socketEpoch: "epoch", peer: "peer", admissionId: "held", fingerprint: "a".repeat(64) },
			async () => {
				entered.resolve();
				await finish.promise;
				return { answer: {}, release: async () => {} };
			},
		);
		void pending.catch(() => {});
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
		host.client("peer");
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
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
		} finally {
			vi.useRealTimers();
			finish.resolve();
			await Promise.allSettled([pending, ending]);
			await host[Symbol.asyncDispose]();
		}
	},
	120_000,
);
