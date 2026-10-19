import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessageEventStream,
	fauxAssistantMessage,
	fauxProvider,
	type ProviderRequestProvenance,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "request-provenance-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

async function consume(stream: AssistantMessageEventStream) {
	for await (const event of stream) {
		if (event.type === "error") throw new Error(event.error.errorMessage);
		if (event.type === "done") return event.message;
	}
	throw new Error("Stream did not finish");
}

async function fixture() {
	const faux = fauxProvider();
	const credentials = AuthStorage.inMemory();
	await credentials.modify("faux", async () => ({
		type: "api_key",
		key: "credential-alpha",
		accounts: [
			{ name: "alpha", key: "credential-alpha" },
			{ name: "bravo", key: "credential-bravo" },
		],
	}));
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, agentDir: dir });
	await runtime.registerNativeProvider({
		...faux.provider,
		auth: {
			apiKey: {
				name: "fixture",
				resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key } }),
			},
		},
	});
	await runtime.refresh({ allowNetwork: false, providers: ["faux"] });
	return { faux, credentials, runtime };
}

describe("runtime request provenance", () => {
	it.each(["stream", "streamSimple"] as const)(
		"%s correlates actual failover without credential values",
		async (method) => {
			const { faux, runtime } = await fixture();
			const seen: (ProviderRequestProvenance | undefined)[] = [];
			const attempts: ProviderRequestProvenance[] = [];
			faux.setResponses([
				() => {
					throw new Error("401 unauthorized");
				},
				fauxAssistantMessage("recovered"),
			]);
			const message = await consume(
				runtime[method](
					faux.getModel(),
					{ messages: [] },
					{
						onRequestAttempt: (provenance) => {
							attempts.push(provenance);
						},
						onResponse: (_response, _model, provenance) => {
							seen.push(provenance);
						},
					},
				),
			);
			expect(seen).toHaveLength(2);
			const calls = faux.getCallLog();
			for (const [index, provenance] of seen.entries()) {
				expect(provenance).toEqual({
					requestId: expect.any(String),
					attemptId: expect.any(String),
					failoverIndex: index,
					slot: { lane: "stored", name: calls[index].options?.apiKey?.replace("credential-", "") },
				});
			}
			expect(seen[0]?.requestId).toBe(seen[1]?.requestId);
			expect(seen[0]?.attemptId).not.toBe(seen[1]?.attemptId);
			expect(JSON.stringify(seen)).not.toContain("credential-");
			expect(attempts).toEqual(seen);
			expect(message.requestProvenance).toEqual(seen[1]);
		},
	);

	it("keeps overlapping requests isolated after the second request completes", async () => {
		const { faux, runtime } = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const seen: (ProviderRequestProvenance | undefined)[] = [];
		faux.setResponses([
			async (_context, options, _state, model) => {
				entered.resolve();
				await release.promise;
				await options?.onProviderStreamEvent?.({ response: { id: "first" } }, model);
				return fauxAssistantMessage("first");
			},
			async (_context, options, _state, model) => {
				await options?.onProviderStreamEvent?.({ response: { id: "second" } }, model);
				return fauxAssistantMessage("second");
			},
		]);
		const options = {
			onProviderStreamEvent: (_data: unknown, _model: unknown, provenance?: ProviderRequestProvenance) => {
				seen.push(provenance);
			},
		};
		const first = consume(
			runtime.streamSimple(faux.getModel(), { messages: [] }, { ...options, apiKey: "first-key" }),
		);
		try {
			await entered.promise;
			await consume(runtime.streamSimple(faux.getModel(), { messages: [] }, { ...options, apiKey: "second-key" }));
			expect(seen).toHaveLength(1);
		} finally {
			release.resolve();
			await first;
		}
		expect(seen).toHaveLength(2);
		expect(seen[0]?.requestId).not.toBe(seen[1]?.requestId);
		expect(seen[0]?.attemptId).not.toBe(seen[1]?.attemptId);
		for (const provenance of seen) {
			expect(provenance).toEqual({
				requestId: expect.any(String),
				attemptId: expect.any(String),
				failoverIndex: 0,
			});
		}
	});

	it.each(["user@example.com", "sk-secret-label", "broker"])(
		"projects only a safe env slot label: %s",
		async (name) => {
			const faux = fauxProvider();
			const modelsPath = join(dir, "models.json");
			writeFileSync(
				modelsPath,
				JSON.stringify({
					providers: {
						faux: {
							credentials: {
								affinity: false,
								slots: { [name]: { value: "private-credential-sentinel" }, backup: { value: "unused-backup" } },
							},
						},
					},
				}),
			);
			const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath, agentDir: dir });
			await runtime.registerNativeProvider(faux.provider);
			await runtime.refresh({ allowNetwork: false, providers: ["faux"] });
			const seen: (ProviderRequestProvenance | undefined)[] = [];
			faux.setResponses([
				() => {
					throw new Error("401 unauthorized");
				},
				fauxAssistantMessage("ok"),
			]);
			await consume(
				runtime.streamSimple(
					faux.getModel(),
					{ messages: [] },
					{
						transformHeaders: (headers, provenance) => {
							seen.push(provenance);
							expect(Object.isFrozen(provenance)).toBe(true);
							expect(Object.isFrozen(provenance?.slot)).toBe(true);
							expect(Reflect.set(provenance?.slot ?? {}, "name", "changed")).toBe(false);
							return headers;
						},
						onResponse: (_response, _model, provenance) => {
							expect(provenance).toBe(seen.at(-1));
						},
					},
				),
			);
			expect(seen.map((provenance) => provenance?.slot)).toEqual(
				expect.arrayContaining([
					{ lane: "env", ...(name === "broker" ? { name } : {}) },
					{ lane: "env", name: "backup" },
				]),
			);
			expect(seen).toHaveLength(2);
			expect(faux.getCallLog().map((call) => call.options?.apiKey)).toContain("private-credential-sentinel");
			expect(JSON.stringify(seen)).not.toContain("private-credential-sentinel");
		},
	);

	it("assigns a new attempt but not a failover to same-slot rejected-token recovery", async () => {
		const { faux, credentials, runtime } = await fixture();
		const expires = Date.now() + 3_600_000;
		await credentials.modify("faux", async () => ({
			type: "oauth",
			access: "old-access",
			refresh: "refresh-secret",
			expires,
			accounts: [
				{ name: "alpha", access: "old-access", refresh: "refresh-secret", expires },
				{ name: "bravo", access: "other-access", refresh: "other-refresh", expires },
			],
		}));
		await runtime.registerNativeProvider({
			...faux.provider,
			auth: {
				oauth: {
					name: "fixture",
					rejectedTokenStatuses: [401],
					login: async () => ({ type: "oauth", access: "old-access", refresh: "refresh-secret", expires }),
					refresh: async (credential) => ({ ...credential, access: "refreshed-access", expires }),
					toAuth: async (credential) => ({ apiKey: credential.access }),
				},
			},
		});
		await runtime.refresh({ allowNetwork: false, providers: ["faux"] });
		const seen: (ProviderRequestProvenance | undefined)[] = [];
		faux.setResponses([
			{
				...fauxAssistantMessage([], { stopReason: "error", errorMessage: "401 unauthorized" }),
				providerDiagnostic: { category: "auth", httpStatus: 401, evidence: "structured_status" },
			},
			fauxAssistantMessage("refreshed"),
		]);
		await consume(
			runtime.streamSimple(
				faux.getModel(),
				{ messages: [] },
				{
					onResponse: (_response, _model, provenance) => {
						seen.push(provenance);
					},
				},
			),
		);
		expect(seen).toHaveLength(2);
		expect(seen[0]?.slot).toEqual(seen[1]?.slot);
		expect(seen[0]?.requestId).toBe(seen[1]?.requestId);
		expect(seen[0]?.attemptId).not.toBe(seen[1]?.attemptId);
		expect(seen.map((provenance) => provenance?.failoverIndex)).toEqual([0, 0]);
		expect(faux.getCallLog()[1].options?.apiKey).toBe("refreshed-access");
	});
});
