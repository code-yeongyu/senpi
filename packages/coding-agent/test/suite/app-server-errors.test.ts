import { describe, expect, it } from "vitest";
import {
	alreadyInitializedError,
	codexErrorInfo,
	experimentalCapabilityError,
	internalError,
	invalidParamsError,
	invalidRequestError,
	methodNotFoundError,
	notInitializedError,
	overloadedError,
	parseError,
	RpcHandlerError,
	serializeCodexErrorInfo,
} from "../../src/modes/app-server/rpc/errors.ts";
import { createRegistry } from "../../src/modes/app-server/rpc/registry.ts";

describe("app-server error model", () => {
	it.each([
		["contextWindowExceeded", codexErrorInfo.contextWindowExceeded(), "contextWindowExceeded"],
		["sessionBudgetExceeded", codexErrorInfo.sessionBudgetExceeded(), "sessionBudgetExceeded"],
		["usageLimitExceeded", codexErrorInfo.usageLimitExceeded(), "usageLimitExceeded"],
		["serverOverloaded", codexErrorInfo.serverOverloaded(), "serverOverloaded"],
		["cyberPolicy", codexErrorInfo.cyberPolicy(), "cyberPolicy"],
		[
			"httpConnectionFailed without status",
			codexErrorInfo.httpConnectionFailed(),
			{ httpConnectionFailed: { httpStatusCode: null } },
		],
		[
			"httpConnectionFailed with status",
			codexErrorInfo.httpConnectionFailed(502),
			{ httpConnectionFailed: { httpStatusCode: 502 } },
		],
		[
			"responseStreamConnectionFailed",
			codexErrorInfo.responseStreamConnectionFailed(503),
			{ responseStreamConnectionFailed: { httpStatusCode: 503 } },
		],
		["internalServerError", codexErrorInfo.internalServerError(), "internalServerError"],
		["unauthorized", codexErrorInfo.unauthorized(), "unauthorized"],
		["badRequest", codexErrorInfo.badRequest(), "badRequest"],
		["threadRollbackFailed", codexErrorInfo.threadRollbackFailed(), "threadRollbackFailed"],
		["sandboxError", codexErrorInfo.sandboxError(), "sandboxError"],
		[
			"responseStreamDisconnected",
			codexErrorInfo.responseStreamDisconnected(504),
			{ responseStreamDisconnected: { httpStatusCode: 504 } },
		],
		[
			"responseTooManyFailedAttempts",
			codexErrorInfo.responseTooManyFailedAttempts(),
			{ responseTooManyFailedAttempts: { httpStatusCode: null } },
		],
		[
			"activeTurnNotSteerable",
			codexErrorInfo.activeTurnNotSteerable("review"),
			{ activeTurnNotSteerable: { turnKind: "review" } },
		],
		["other", codexErrorInfo.other(), "other"],
	])("serializes %s to the codex wire shape", (_name, info, expected) => {
		// Given: a locally declared CodexErrorInfo variant.
		// When: it is serialized for the app-server wire.
		const serialized = serializeCodexErrorInfo(info);

		// Then: the payload matches upstream v2/shared.rs camelCase representation.
		expect(serialized).toEqual(expected);
	});

	it("builds the canonical JSON-RPC errors", () => {
		// Given: each standard app-server JSON-RPC failure.
		// When: the builders are called.
		const errors = [
			parseError(),
			invalidRequestError(),
			methodNotFoundError("thread/missing"),
			invalidParamsError(),
			overloadedError(),
			notInitializedError(),
			alreadyInitializedError(),
			experimentalCapabilityError("exp/m"),
			internalError("handler failed"),
		];

		// Then: codes and exact messages match the plan contract.
		expect(errors).toEqual([
			{ code: -32700, message: "Parse error" },
			{ code: -32600, message: "Invalid request" },
			{ code: -32601, message: "Method not found: thread/missing" },
			{ code: -32602, message: "Invalid params" },
			{ code: -32001, message: "Server overloaded; retry later." },
			{ code: -32600, message: "Not initialized" },
			{ code: -32600, message: "Already initialized" },
			{ code: -32600, message: "exp/m requires experimentalApi capability" },
			{ code: -32603, message: "handler failed" },
		]);
	});
});

describe("app-server method registry", () => {
	it("returns Not initialized before method lookup for non-initialize requests", async () => {
		// Given: an uninitialized connection and a registry that does not know the method.
		const registry = createRegistry();
		const connection = { initialized: false, capabilities: {} };

		// When: an unknown non-initialize request is dispatched.
		const response = await registry.dispatch(connection, { id: 1, method: "nope/missing", params: {} });

		// Then: the initialize gate wins over method lookup.
		expect(response).toEqual({ id: 1, error: { code: -32600, message: "Not initialized" } });
	});

	it("returns method-not-found with the requested method after initialization", async () => {
		// Given: an initialized connection.
		const registry = createRegistry();
		const connection = { initialized: true, capabilities: {} };

		// When: an unknown method is dispatched.
		const response = await registry.dispatch(connection, { id: "abc", method: "thread/missing" });

		// Then: -32601 includes the method name.
		expect(response).toEqual({
			id: "abc",
			error: { code: -32601, message: "Method not found: thread/missing" },
		});
	});

	it("rejects experimental methods without experimentalApi capability", async () => {
		// Given: an initialized connection without experimentalApi.
		const registry = createRegistry();
		const connection = { initialized: true, capabilities: { experimentalApi: false } };
		registry.register("exp/m", { experimental: true, handler: async () => ({ ok: true }) });

		// When: the experimental method is dispatched.
		const response = await registry.dispatch(connection, { id: 2, method: "exp/m" });

		// Then: the response uses the exact experimental rejection wording.
		expect(response).toEqual({
			id: 2,
			error: { code: -32600, message: "exp/m requires experimentalApi capability" },
		});
	});

	it("maps thrown handlers to internal errors instead of throwing across dispatch", async () => {
		// Given: a registered handler that throws.
		const registry = createRegistry();
		const connection = { initialized: true, capabilities: { experimentalApi: true } };
		registry.register("boom/m", {
			handler: async () => {
				throw new Error("boom");
			},
		});

		// When: the method is dispatched.
		const response = await registry.dispatch(connection, { id: 3, method: "boom/m" });

		// Then: the thrown error is converted to a JSON-RPC internal error.
		expect(response).toEqual({ id: 3, error: { code: -32603, message: "boom" } });
	});

	it("preserves typed JSON-RPC errors thrown by handlers instead of masking them as internal", async () => {
		// Given: a handler that throws a typed invalid-params failure (e.g. the turn engine).
		const registry = createRegistry();
		const connection = { initialized: true, capabilities: { experimentalApi: true } };
		registry.register("typed/m", {
			handler: async () => {
				throw new RpcHandlerError({ code: -32602, message: "Invalid params: input must be an array" });
			},
		});

		// When: the method is dispatched.
		const response = await registry.dispatch(connection, { id: 4, method: "typed/m" });

		// Then: the intended code survives dispatch.
		expect(response).toEqual({
			id: 4,
			error: { code: -32602, message: "Invalid params: input must be an array" },
		});
	});

	it("allows initialize before the init gate and rejects repeated initialize", async () => {
		// Given: initialize is registered as pre-init capable.
		const registry = createRegistry();
		registry.register("initialize", {
			requiresInit: false,
			handler: async () => ({ userAgent: "senpi-test" }),
		});

		// When: initialize is dispatched before and after connection initialization.
		const first = await registry.dispatch({ initialized: false, capabilities: {} }, { id: 4, method: "initialize" });
		const second = await registry.dispatch({ initialized: true, capabilities: {} }, { id: 5, method: "initialize" });

		// Then: pre-init initialize runs, but repeat initialize is rejected.
		expect(first).toEqual({ id: 4, result: { userAgent: "senpi-test" } });
		expect(second).toEqual({ id: 5, error: { code: -32600, message: "Already initialized" } });
	});
});
