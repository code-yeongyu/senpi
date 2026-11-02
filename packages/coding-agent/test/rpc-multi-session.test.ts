import { describe, expect, test, vi } from "vitest";
import {
	RPC_ERROR_MISSING_SESSION_ID,
	RPC_ERROR_MULTI_SESSION_DISABLED,
	RPC_ERROR_SESSION_CLOSING,
	RPC_ERROR_UNKNOWN_SESSION,
} from "../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../src/modes/rpc/session-event-writer.ts";

function routerFor(state: "open" | "closing" = "open") {
	const registry = {
		list: () => [],
		getForCommand: (id: string) => {
			if (id !== "known") throw Object.assign(new Error("unknown_session"), { code: "unknown_session" });
			if (state === "closing") throw Object.assign(new Error("session_closing"), { code: "session_closing" });
			return { state, runtime: {} };
		},
		close: async () => {},
	} as never;
	return new SessionCommandRouter(registry, new SessionEventWriter(() => {}), { cwd: "/tmp" });
}

describe("multi-session RPC routing", () => {
	test("requires a routing session id for established commands", async () => {
		const response = await routerFor().handle({ id: "p", type: "prompt", message: "hello" });
		expect(response).toMatchObject({ success: false, error: RPC_ERROR_MISSING_SESSION_ID });
	});

	test("reports unknown and closing session handles with stable codes", async () => {
		expect(await routerFor().handle({ id: "p", type: "prompt", message: "hello", sessionId: "gone" })).toMatchObject({
			error: RPC_ERROR_UNKNOWN_SESSION,
		});
		expect(
			await routerFor().handle({ id: "live-without-binding", type: "prompt", message: "hello", sessionId: "known" }),
		).toMatchObject({ error: RPC_ERROR_UNKNOWN_SESSION });
		expect(
			await routerFor("closing").handle({ id: "p", type: "prompt", message: "hello", sessionId: "known" }),
		).toMatchObject({ error: RPC_ERROR_SESSION_CLOSING });
	});

	test("forwards client capabilities into each opened session binding", async () => {
		const entry = {
			runtime: {
				session: {
					model: undefined,
					thinkingLevel: "off",
					isStreaming: false,
					isCompacting: false,
					steeringMode: "one-at-a-time",
					followUpMode: "one-at-a-time",
					sessionFile: undefined,
					sessionId: "durable-session-beta",
					sessionName: undefined,
				},
			},
		};
		const registry = {
			openSession: async () => ({ sessionId: "rpc-session-beta" }),
			getForCommand: () => entry,
			list: () => [],
			beginClose: () => entry,
			closeMarked: async () => {},
			peek: () => undefined,
		} as never;
		const createBinding = vi.fn(async () => ({
			handle: async () => {},
			dispose: async () => {},
		}));
		const writer = new SessionEventWriter(() => {});
		const router = Reflect.construct(SessionCommandRouter, [
			registry,
			writer,
			{ cwd: "/tmp" },
			createBinding,
			{ capabilities: ["extension_events"] },
		]) as SessionCommandRouter;

		await router.handle({ id: "open", type: "open_session", cwd: "/tmp" });

		expect(createBinding).toHaveBeenCalledWith(
			"rpc-session-beta",
			entry,
			writer,
			expect.any(Function),
			expect.objectContaining({ capabilities: ["extension_events"], clientInfo: expect.any(Object) }),
		);
	});

	test("forwards launch capabilities to connection-owned bindings and honors explicit empty capabilities", async () => {
		const entry = {
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
		const sessionIds = ["rpc-session-env", "rpc-session-explicit-empty"];
		const registry = {
			openSession: async () => ({ sessionId: sessionIds.shift() ?? "unexpected" }),
			getForCommand: () => entry,
			list: () => [],
			beginClose: () => entry,
			closeMarked: async () => {},
			peek: () => undefined,
		} as never;
		const chunks: string[] = [];
		const writer = new SessionEventWriter(
			(chunk) => chunks.push(chunk),
			(flush) => flush(),
		);
		writer.registerConnection("client", {
			writeRaw: (chunk) => chunks.push(chunk),
			waitForBackpressure: async () => {},
		});
		const emitters = new Map<string, () => void>();
		const createBinding = vi.fn(
			async (
				sessionId: string,
				_entry: unknown,
				eventWriter: SessionEventWriter,
				_close: unknown,
				options: { capabilities?: readonly string[] },
			) => {
				const forwardsExtensionEvents = options.capabilities?.includes("extension_events") ?? false;
				emitters.set(sessionId, () => {
					if (!forwardsExtensionEvents) return;
					eventWriter.enqueue(sessionId, {
						type: "extension_event",
						name: "fixture.progress",
						data: { step: 1 },
					});
				});
				return { handle: async () => {}, dispose: async () => {} };
			},
		);
		const router = Reflect.construct(SessionCommandRouter, [
			registry,
			writer,
			{ cwd: "/tmp" },
			createBinding,
			{ capabilities: ["extension_events"] },
		]) as SessionCommandRouter;

		await writer.withConnection("client", () => router.handle({ id: "open-env", type: "open_session", cwd: "/tmp" }));
		emitters.get("rpc-session-env")?.();
		await writer.flush();
		expect(JSON.parse(chunks.join("").split("\n").filter(Boolean).at(-1) ?? "{}")).toMatchObject({
			type: "extension_event",
			name: "fixture.progress",
			sessionId: "rpc-session-env",
		});

		await writer.withConnection("client", () =>
			router.handle({ id: "info", type: "set_client_info", width: 80, capabilities: [] }),
		);
		await writer.withConnection("client", () =>
			router.handle({ id: "open-empty", type: "open_session", cwd: "/tmp" }),
		);
		emitters.get("rpc-session-explicit-empty")?.();
		await writer.flush();
		expect(
			chunks
				.join("")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { type?: string; sessionId?: string })
				.filter((record) => record.type === "extension_event" && record.sessionId === "rpc-session-explicit-empty"),
		).toEqual([]);
	});

	test("routes extension requests only to the addressed session binding", async () => {
		const sessionIds = ["rpc-session-alpha", "rpc-session-beta"];
		const entryFor = (sessionId: string) => ({
			runtime: {
				session: {
					model: undefined,
					thinkingLevel: "off",
					isStreaming: false,
					isCompacting: false,
					steeringMode: "one-at-a-time",
					followUpMode: "one-at-a-time",
					sessionFile: undefined,
					sessionId: `durable-${sessionId}`,
					sessionName: undefined,
					autoCompactionEnabled: true,
					messages: [],
					pendingMessageCount: 0,
				},
			},
		});
		const registry = {
			openSession: async () => ({ sessionId: sessionIds.shift() ?? "unexpected" }),
			getForCommand: (sessionId: string) => entryFor(sessionId),
			list: () => [],
			beginClose: () => entryFor("closing"),
			closeMarked: async () => {},
			peek: () => undefined,
		} as never;
		const alphaHandle = vi.fn(async () => {});
		const betaHandle = vi.fn(async () => {});
		const createBinding = vi.fn(async (sessionId: string) => ({
			handle: sessionId === "rpc-session-alpha" ? alphaHandle : betaHandle,
			dispose: async () => {},
		}));
		const router = Reflect.construct(SessionCommandRouter, [
			registry,
			new SessionEventWriter(() => {}),
			{ cwd: "/tmp" },
			createBinding,
		]) as SessionCommandRouter;
		await router.handle({ id: "open-alpha", type: "open_session", cwd: "/tmp" });
		await router.handle({ id: "open-beta", type: "open_session", cwd: "/tmp" });

		await router.handle({
			id: "request-beta",
			type: "extension_request",
			sessionId: "rpc-session-beta",
			name: "fixture.owner",
			data: { expected: "beta" },
		});

		expect(alphaHandle).not.toHaveBeenCalled();
		expect(betaHandle).toHaveBeenCalledWith({
			id: "request-beta",
			type: "extension_request",
			sessionId: "rpc-session-beta",
			name: "fixture.owner",
			data: { expected: "beta" },
		});
	});

	test("keeps the classic-only open error code stable", () => {
		expect(RPC_ERROR_MULTI_SESSION_DISABLED).toBe("multi_session_disabled");
	});
});
