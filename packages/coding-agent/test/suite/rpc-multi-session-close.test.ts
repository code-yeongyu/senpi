import { describe, expect, test, vi } from "vitest";
import { SessionCommandRouter } from "../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";

describe("multi-session RPC close routing", () => {
	test("preserves terminal record order for a joined close", async () => {
		const entry: { state: "open" | "closing"; runtime: object } = {
			state: "open",
			runtime: {
				session: {
					model: undefined,
					thinkingLevel: "off",
					isStreaming: false,
					isCompacting: false,
					steeringMode: "one-at-a-time",
					followUpMode: "one-at-a-time",
					sessionFile: undefined,
					sessionId: "durable-session",
					sessionName: undefined,
				},
			},
		};
		let releaseDispose!: () => void;
		const disposing = new Promise<void>((resolve) => {
			releaseDispose = resolve;
		});
		const closeCompletion = Promise.resolve();
		let closeCalls = 0;
		const registry = {
			openSession: async () => ({ sessionId: "rpc-session" }),
			getForCommand: () => entry,
			list: () => [],
			beginClose: (_id: string, onRole?: (finalizer: boolean) => void) => {
				const finalizer = closeCalls === 0;
				closeCalls += 1;
				entry.state = "closing";
				onRole?.(finalizer);
				return entry;
			},
			closeMarked: async () => closeCompletion,
			peek: () => ({ closeCompletion }),
		} as never;
		const dispose = vi.fn(() => disposing);
		const records: Array<Record<string, unknown>> = [];
		const writer = new SessionEventWriter(
			(chunk) => records.push(JSON.parse(chunk) as Record<string, unknown>),
			(flush) => flush(),
		);
		const router = Reflect.construct(SessionCommandRouter, [
			registry,
			writer,
			{ cwd: "/tmp" },
			async () => ({ handle: async () => {}, dispose }),
		]) as SessionCommandRouter;
		await router.handle({ id: "open", type: "open_session", cwd: "/tmp" });
		const first = router.handle({ id: "first", type: "close_session", sessionId: "rpc-session" });
		const second = router.handle({ id: "second", type: "close_session", sessionId: "rpc-session" });
		expect(dispose).toHaveBeenCalledTimes(1);
		releaseDispose();
		await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
		await writer.flush();
		expect(records.filter((record) => record.sessionId === "rpc-session")).toEqual([
			{ type: "session_opened", sessionId: "rpc-session" },
			{ type: "session_closed", sessionId: "rpc-session", reason: "client_close" },
			expect.objectContaining({ id: "first", command: "close_session", success: true, sessionId: "rpc-session" }),
			expect.objectContaining({ id: "second", command: "close_session", success: true, sessionId: "rpc-session" }),
		]);
	});

	test("answers a close once and releases joiners when the binding fails to dispose", async () => {
		const entry: { state: "open" | "closing"; runtime: object } = { state: "open", runtime: { session: {} } };
		let closeCalls = 0;
		const closeMarked = vi.fn(async () => {});
		const registry = {
			openSession: async () => ({ sessionId: "rpc-session" }),
			getForCommand: () => entry,
			list: () => [],
			beginClose: (_id: string, onRole?: (finalizer: boolean) => void) => {
				const finalizer = closeCalls === 0;
				closeCalls += 1;
				entry.state = "closing";
				onRole?.(finalizer);
				return entry;
			},
			closeMarked,
			peek: () => undefined,
		} as never;
		const records: Array<Record<string, unknown>> = [];
		const writer = new SessionEventWriter(
			(chunk) => records.push(JSON.parse(chunk) as Record<string, unknown>),
			(flush) => flush(),
		);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const router = Reflect.construct(SessionCommandRouter, [
				registry,
				writer,
				{ cwd: "/tmp" },
				async () => ({
					handle: async () => {},
					dispose: async () => Promise.reject(new Error("binding exploded")),
				}),
			]) as SessionCommandRouter;
			await router.handle({ id: "open", type: "open_session", cwd: "/tmp" });
			const first = router.handle({ id: "first", type: "close_session", sessionId: "rpc-session" });
			const second = router.handle({ id: "second", type: "close_session", sessionId: "rpc-session" });
			await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
			await writer.flush();
			expect(closeMarked).toHaveBeenCalledTimes(1);
			expect(records.filter((record) => record.sessionId === "rpc-session")).toEqual([
				{ type: "session_opened", sessionId: "rpc-session" },
				{ type: "session_closed", sessionId: "rpc-session", reason: "client_close" },
				expect.objectContaining({ id: "first", command: "close_session", success: true }),
				expect.objectContaining({ id: "second", command: "close_session", success: true }),
			]);
			expect(stderr.mock.calls.some(([chunk]) => String(chunk).includes("binding exploded"))).toBe(true);
		} finally {
			stderr.mockRestore();
		}
	});

	test("releases a joining close and disposes the binding once", async () => {
		const entry: { state: "open" | "closing"; runtime: object } = { state: "open", runtime: { session: {} } };
		let closeCalls = 0;
		const registry = {
			openSession: async () => ({ sessionId: "rpc-session" }),
			getForCommand: () => entry,
			list: () => [],
			beginClose: (_id: string, onRole?: (finalizer: boolean) => void) => {
				const finalizer = closeCalls === 0;
				closeCalls += 1;
				entry.state = "closing";
				onRole?.(finalizer);
				return entry;
			},
			closeMarked: async () => {},
			peek: () => undefined,
		} as never;
		const writer = new SessionEventWriter(() => {});
		writer.registerConnection("owner", { writeRaw: () => {}, waitForBackpressure: async () => {} });
		const dispose = vi.fn(async () => {});
		const router = Reflect.construct(SessionCommandRouter, [
			registry,
			writer,
			{ cwd: "/tmp" },
			async () => ({ handle: async () => {}, dispose }),
		]) as SessionCommandRouter;
		await writer.withConnection("owner", () => router.handle({ id: "open", type: "open_session", cwd: "/tmp" }));
		const first = writer.withConnection("owner", () =>
			router.handle({ id: "first", type: "close_session", sessionId: "rpc-session" }),
		);
		const second = router.handle({ id: "second", type: "close_session", sessionId: "rpc-session" });
		const settled = await Promise.race([
			Promise.all([first, second]).then(() => "settled" as const),
			new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
		]);
		expect(settled).toBe("settled");
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	test("does not dispose a binding twice when idle eviction races explicit close", async () => {
		const entry: { state: "open" | "closing"; runtime: object } = {
			state: "open",
			runtime: {
				session: {
					model: undefined,
					thinkingLevel: "off",
					isStreaming: false,
					isCompacting: false,
					steeringMode: "one-at-a-time",
					followUpMode: "one-at-a-time",
					sessionFile: undefined,
					sessionId: "durable-session",
					sessionName: undefined,
					sessionManager: { getSessionName: () => undefined },
				},
			},
		};
		let releaseDispose!: () => void;
		const disposing = new Promise<void>((resolve) => {
			releaseDispose = resolve;
		});
		const registry = {
			openSession: async () => ({ sessionId: "known" }),
			getForCommand: () => entry,
			list: () => [{ sessionId: "known", status: entry.state }],
			peek: () => entry,
			beginClose: (_id: string, onRole?: (finalizer: boolean) => void) => {
				const finalizer = entry.state === "open";
				entry.state = "closing";
				onRole?.(finalizer);
				return entry;
			},
			closeMarked: async () => {},
		} as never;
		const dispose = vi.fn(() => disposing);
		const router = Reflect.construct(SessionCommandRouter, [
			registry,
			new SessionEventWriter(() => {}),
			{ cwd: "/tmp" },
			async () => ({ handle: async () => {}, dispose }),
			{},
			{ idleEvictionMs: 1, now: () => 100 },
		]) as SessionCommandRouter;
		await router.handle({ id: "open", type: "open_session", cwd: "/tmp" });
		const close = router.handle({ id: "close", type: "close_session", sessionId: "known" });
		router.sweepIdleSessions();
		const disposingRouter = router.dispose();
		releaseDispose();
		await expect(Promise.all([close, disposingRouter])).resolves.toEqual([undefined, undefined]);
		expect(dispose).toHaveBeenCalledTimes(1);
	});
});
