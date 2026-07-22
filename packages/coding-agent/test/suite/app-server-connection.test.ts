import { describe, expect, it } from "vitest";
import { VERSION } from "../../src/config.ts";
import type { ClassifiedIncoming, RpcEnvelope } from "../../src/modes/app-server/rpc/envelope.ts";
import { createConnection } from "../../src/modes/app-server/server/connection.ts";
import { ServerCore } from "../../src/modes/app-server/server/server-core.ts";

type SentMessage = RpcEnvelope;

function request(id: string | number, method: string, params: unknown = {}): ClassifiedIncoming {
	return { kind: "request", message: { id, method, params } };
}

function notification(method: string, params: unknown = {}): ClassifiedIncoming {
	return { kind: "notification", message: { method, params } };
}

function createCoreWithConnection(): { readonly core: ServerCore; readonly sent: SentMessage[]; readonly id: string } {
	const core = new ServerCore();
	const sent: SentMessage[] = [];
	const connection = core.addConnection({
		id: "conn-1",
		transportKind: "stdio",
		send: (message) => {
			sent.push(message);
		},
		close: () => undefined,
	});
	return { core, sent, id: connection.id };
}

describe("app-server connection initialize gate", () => {
	it("rejects requests before initialize with the exact upstream message", async () => {
		// Given: a fresh uninitialized connection.
		const { core, sent, id } = createCoreWithConnection();

		// When: a normal client request arrives before initialize.
		await core.receive(id, request(9, "thread/list"));

		// Then: the initialize gate rejects it before method lookup.
		expect(sent).toEqual([{ id: 9, error: { code: -32600, message: "Not initialized" } }]);
	});

	it("initializes once, stores capabilities, and rejects a second initialize", async () => {
		// Given: a fresh connection.
		const { core, sent, id } = createCoreWithConnection();

		// When: initialize is sent twice.
		await core.receive(
			id,
			request(1, "initialize", {
				clientInfo: { name: "qa", title: "QA", version: "0.0.1" },
				capabilities: {
					experimentalApi: true,
					requestAttestation: false,
					optOutNotificationMethods: ["thread/started"],
				},
			}),
		);
		await core.receive(id, request(2, "initialize", { clientInfo: { name: "qa", version: "0.0.1" } }));

		// Then: the first response is successful and the second uses the exact repeated-init error.
		expect("result" in sent[0] ? sent[0].result : undefined).toMatchObject({
			codexHome: expect.any(String),
			platformFamily: expect.stringMatching(/^(unix|windows)$/),
			platformOs: expect.stringMatching(/^(macos|linux|windows)$/),
			userAgent: expect.stringMatching(
				new RegExp(`^qa/${VERSION.replaceAll(".", "\\.")} \\(.+\\) senpi_app_server$`),
			),
		});
		expect(core.getConnection(id)?.capabilities.experimentalApi).toBe(true);
		expect(core.getConnection(id)?.optOutNotificationMethods.has("thread/started")).toBe(true);
		expect(sent[1]).toEqual({ id: 2, error: { code: -32600, message: "Already initialized" } });
	});

	it("keeps direct connection initialization single-use and response-free", () => {
		// Given: a fresh connection owned by ServerCore's transport layer.
		const connection = createConnection({
			id: "conn-direct",
			transportKind: "stdio",
			send: () => undefined,
			close: () => undefined,
		});

		// When: a caller initializes it directly and then attempts to initialize it again.
		const firstResult = connection.initialize(
			{ clientInfo: { name: "qa", title: "QA", version: "0.0.1" }, capabilities: null },
			"2026.7.2",
		);
		const initializedState = connection.initializedState;
		const secondResult = connection.initialize(
			{ clientInfo: { name: "other", title: null, version: "1.0.0" }, capabilities: null },
			"0.0.0",
		);

		// Then: Connection reports only state transition status and preserves the original initialized state.
		expect(firstResult).toEqual({ kind: "initialized" });
		expect(secondResult).toEqual({ kind: "already-initialized" });
		expect(connection.initializedState).toBe(initializedState);
		expect(connection.initializedState?.clientInfo.name).toBe("qa");
	});

	it("returns invalid params when clientInfo is missing", async () => {
		// Given: a fresh connection.
		const { core, sent, id } = createCoreWithConnection();

		// When: initialize omits the required generated InitializeParams.clientInfo field.
		await core.receive(id, request(1, "initialize", { capabilities: { experimentalApi: true } }));

		// Then: the request is rejected as invalid params.
		expect(sent).toEqual([{ id: 1, error: { code: -32602, message: "Invalid params" } }]);
	});

	it("responds with the same field keys as the upstream handshake", async () => {
		// Given: the upstream qa-upstream-handshake.txt initialize response shape.
		const upstreamInitializeKeys = ["userAgent", "codexHome", "platformFamily", "platformOs"];
		const { core, sent, id } = createCoreWithConnection();

		// When: initialize succeeds and the initialized notification follows.
		await core.receive(id, request(1, "initialize", { clientInfo: { name: "qa", title: "QA", version: "0.0.1" } }));
		await core.receive(id, notification("initialized"));

		// Then: the response omits jsonrpc/protocolVersion and uses exactly the observed result keys.
		const response = sent[0];
		expect(response).toEqual({ id: 1, result: expect.any(Object) });
		const result = "result" in response ? response.result : undefined;
		expectRecord(result);
		expect(Object.keys(result).sort()).toEqual([...upstreamInitializeKeys].sort());
		expect(response).not.toHaveProperty("jsonrpc");
		expect(result).not.toHaveProperty("protocolVersion");
	});

	it("drops opted-out outbound notifications", async () => {
		// Given: an initialized connection that opted out of thread/started.
		const { core, sent, id } = createCoreWithConnection();
		await core.receive(
			id,
			request(1, "initialize", {
				clientInfo: { name: "qa", version: "0.0.1" },
				capabilities: {
					experimentalApi: false,
					requestAttestation: false,
					optOutNotificationMethods: ["thread/started"],
				},
			}),
		);

		// When: the server emits an opted-out notification and a normal notification.
		await core.sendNotificationToConnection(id, { method: "thread/started", params: { thread: { id: "thread-1" } } });
		await core.sendNotificationToConnection(id, {
			method: "thread/status/changed",
			params: { threadId: "thread-1" },
		});

		// Then: only the non-opted-out notification is delivered after the initialize response.
		expect(sent).toEqual([
			{ id: 1, result: expect.any(Object) },
			{
				method: "thread/status/changed",
				params: { threadId: "thread-1" },
				emittedAtMs: expect.any(Number),
			},
		]);
	});
});

function expectRecord(value: unknown): asserts value is Record<string, unknown> {
	expect(typeof value).toBe("object");
	expect(value).not.toBeNull();
	expect(Array.isArray(value)).toBe(false);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("expected record");
	}
}
