import { type Context, fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AuthBrokerRemoteStore } from "../../src/core/auth-broker-remote-store.ts";
import {
	AUTH_BROKER_PROTOCOL_VERSION,
	type AuthBrokerWireRequest,
	parseAuthBrokerWireRequest,
} from "../../src/core/auth-broker-wire-contract.ts";
import {
	type AuthGatewayProviderRuntime,
	type AuthGatewayProviderRuntimeResult,
	createAuthGatewayProviderRuntime,
} from "../../src/core/auth-gateway-provider-runtime.ts";

const runtimes: AuthGatewayProviderRuntime[] = [];

afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.close();
});

describe("auth gateway provider runtime", () => {
	it("rotates concurrent processes and reports idempotent outcomes through shared runtime", async () => {
		// Given: two broker leases and a faux provider with upstream request configuration.
		const broker = createBroker(["lease-a", "lease-b", "lease-401", "lease-429", "lease-transient"]);
		const faux = registerFauxProvider({ api: "gateway-faux", provider: "gateway-provider" });
		faux.setResponses([
			fauxAssistantMessage("first"),
			fauxAssistantMessage("second"),
			fauxAssistantMessage("", { errorMessage: "HTTP 401", stopReason: "error" }),
			fauxAssistantMessage("", { errorMessage: "HTTP 429", stopReason: "error" }),
			fauxAssistantMessage("", { errorMessage: "upstream reset", stopReason: "error" }),
		]);
		const runtime = createRuntime(broker.store, faux.getModel());

		try {
			// When: concurrent calls flow through the single runtime seam.
			const [first, second] = await Promise.all([
				runtime.stream(callRequest({ sessionId: "cache-affinity-a" })),
				runtime.stream(callRequest({ modelId: "gateway-faux-1" })),
			]);

			// Then: each call selects before streaming, keeps its opaque lease, and reports once.
			expect(first.kind).toBe("stream");
			expect(second.kind).toBe("stream");
			if (first.kind !== "stream" || second.kind !== "stream") throw new Error("Expected gateway streams");
			expect([first.leaseId, second.leaseId].sort()).toEqual(["lease-a", "lease-b"]);
			expect(broker.selectionSessionIds).toEqual(["cache-affinity-a", undefined]);
			await Promise.all([first.stream.result(), second.stream.result()]);
			await flushReports();
			const unauthorized = await expectStream(runtime.stream(callRequest()));
			const rateLimited = await expectStream(runtime.stream(callRequest()));
			const transient = await expectStream(runtime.stream(callRequest()));
			await Promise.all([unauthorized.stream.result(), rateLimited.stream.result(), transient.stream.result()]);
			await flushReports();
			expect(broker.outcomes).toEqual([
				{ leaseId: first.leaseId, status: "success" },
				{ leaseId: second.leaseId, status: "success" },
				{ leaseId: unauthorized.leaseId, status: "unauthorized" },
				{ leaseId: rateLimited.leaseId, status: "rate_limited" },
				{ leaseId: transient.leaseId, status: "unavailable" },
			]);
			expect(faux.getCallLog()).toHaveLength(5);
			for (const entry of faux.getCallLog()) {
				expect(entry.modelId).toBe("upstream-model");
				expect(entry.options).toMatchObject({
					apiKey: "provider-secret",
					env: { GATEWAY_REGION: "test" },
					headers: { "x-gateway": "shared" },
					maxRetries: 2,
					timeoutMs: 123,
				});
			}
		} finally {
			faux.unregister();
		}
	});

	it("cancels faux stream on abort and returns deterministic queue-overload result with no secret log", async () => {
		// Given: one slow faux stream, an abort signal, and a runtime limited to one active call.
		let unblock: (() => void) | undefined;
		const blocked = new Promise<void>((resolve) => {
			unblock = resolve;
		});
		const broker = createBroker(["lease-abort"]);
		const faux = registerFauxProvider({
			api: "gateway-faux-abort",
			provider: "gateway-provider",
			schedulerHook: async () => blocked,
		});
		faux.setResponses([fauxAssistantMessage("long enough to schedule")]);
		const runtime = createRuntime(broker.store, faux.getModel(), 1);
		const controller = new AbortController();

		try {
			// When: the active stream is aborted while a second call arrives.
			const active = await runtime.stream(callRequest({ signal: controller.signal }));
			const overloaded = await runtime.stream(callRequest());
			controller.abort();
			unblock?.();

			// Then: cancellation reaches the faux stream, overload is fixed, and secrets never enter diagnostics.
			expect(active.kind).toBe("stream");
			if (active.kind !== "stream") throw new Error("Expected active gateway stream");
			expect(overloaded).toEqual({ kind: "overloaded", statusCode: 503 });
			const message = await active.stream.result();
			expect(message.stopReason).toBe("aborted");
			await flushReports();
			expect(broker.outcomes).toEqual([{ leaseId: "lease-abort", status: "unavailable" }]);
			expect(JSON.stringify({ outcomes: broker.outcomes, overloaded })).not.toContain("provider-secret");
		} finally {
			faux.unregister();
		}
	});
});

async function expectStream(
	result: Promise<AuthGatewayProviderRuntimeResult>,
): Promise<Extract<AuthGatewayProviderRuntimeResult, { readonly kind: "stream" }>> {
	const value = await result;
	if (value.kind !== "stream") throw new Error("Expected gateway stream");
	return value;
}

async function flushReports(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function createRuntime(
	broker: AuthBrokerRemoteStore,
	model: ReturnType<ReturnType<typeof registerFauxProvider>["getModel"]>,
	maxConcurrentCalls = 2,
): AuthGatewayProviderRuntime {
	const runtime = createAuthGatewayProviderRuntime({
		broker,
		maxConcurrentCalls,
		resolveModel: () => model,
		resolveRequest: () => ({
			env: { GATEWAY_REGION: "test" },
			headers: { "x-gateway": "shared" },
			maxRetries: 2,
			timeoutMs: 123,
			upstreamModelId: "upstream-model",
		}),
	});
	runtimes.push(runtime);
	return runtime;
}

function callRequest(
	overrides: { readonly modelId?: string; readonly sessionId?: string; readonly signal?: AbortSignal } = {},
) {
	const context: Context = { messages: [] };
	return {
		context,
		modelId: overrides.modelId ?? "gateway-faux-1",
		provider: "gateway-provider",
		signal: overrides.signal,
		streamOptions: overrides.sessionId === undefined ? undefined : { sessionId: overrides.sessionId },
	};
}

function createBroker(leaseIds: readonly string[]): {
	readonly outcomes: Array<{ readonly leaseId: string; readonly status: string }>;
	readonly selectionSessionIds: Array<string | undefined>;
	readonly store: AuthBrokerRemoteStore;
} {
	const outcomes: Array<{ readonly leaseId: string; readonly status: string }> = [];
	const selectionSessionIds: Array<string | undefined> = [];
	let selectionIndex = 0;
	const store = new AuthBrokerRemoteStore({
		async request(request: unknown) {
			const message = parseAuthBrokerWireRequest(request);
			return brokerResponse(message, leaseIds, outcomes, selectionSessionIds, () => selectionIndex++);
		},
	});
	return { outcomes, selectionSessionIds, store };
}

function brokerResponse(
	request: AuthBrokerWireRequest,
	leaseIds: readonly string[],
	outcomes: Array<{ readonly leaseId: string; readonly status: string }>,
	selectionSessionIds: Array<string | undefined>,
	nextSelection: () => number,
) {
	switch (request.operation) {
		case "metadata_snapshot":
			return {
				operation: request.operation,
				protocolVersion: AUTH_BROKER_PROTOCOL_VERSION,
				requestId: request.requestId,
				snapshot: {
					credentials: [
						{
							createdAt: "2026-07-11T00:00:00.000Z",
							credentialId: "credential-gateway",
							identityKey: "gateway",
							pool: { provider: "gateway-provider", type: "api_key" as const },
							updatedAt: "2026-07-11T00:00:00.000Z",
						},
					],
					generatedAt: "2026-07-11T00:00:00.000Z",
				},
			} as const;
		case "selection_lease": {
			selectionSessionIds.push(
				"sessionId" in request.payload && typeof request.payload.sessionId === "string"
					? request.payload.sessionId
					: undefined,
			);
			const leaseId = leaseIds[nextSelection()];
			if (leaseId === undefined) throw new Error("Fixture lease exhausted");
			return {
				lease: {
					credentialId: `credential-${leaseId}`,
					leaseId,
					material: { apiKey: "provider-secret", type: "api_key" as const },
					pool: { provider: request.payload.pool.provider, type: "api_key" as const },
				},
				operation: request.operation,
				protocolVersion: AUTH_BROKER_PROTOCOL_VERSION,
				requestId: request.requestId,
			} as const;
		}
		case "outcome_report":
			outcomes.push({ leaseId: request.payload.leaseId, status: request.payload.status });
			return {
				operation: request.operation,
				protocolVersion: AUTH_BROKER_PROTOCOL_VERSION,
				recorded: true,
				requestId: request.requestId,
			} as const;
		case "disable":
		case "refresh":
			throw new Error("Unexpected broker request");
	}
}
