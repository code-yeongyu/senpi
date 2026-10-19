import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxProvider,
	type ProviderRequestProvenance,
} from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";

// #3614: an SDK-owned attempt must outrank a generic wrapper's preparation slot.
it("shares actual provider attempt identity across outer retries without attributing preparation slots", async () => {
	const dir = mkdtempSync(join(tmpdir(), "provider-owned-provenance-"));
	try {
		const credentials = AuthStorage.inMemory();
		await credentials.modify("faux", async () => ({
			type: "api_key",
			key: "preparation-one",
			accounts: [
				{ name: "one", key: "preparation-one" },
				{ name: "two", key: "preparation-two" },
			],
		}));
		const faux = fauxProvider();
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, agentDir: dir });
		await runtime.registerNativeProvider({ ...faux.provider, providesRequestProvenance: true });
		await runtime.refresh({ allowNetwork: false, providers: ["faux"] });
		const attempts: ProviderRequestProvenance[] = [];
		const raw: (ProviderRequestProvenance | undefined)[] = [];
		const serve: FauxResponseFactory = async (_context, options, state, model) => {
			const create = options?.createRequestProvenance;
			if (!create) throw new Error("Provider-owned attempt factory is missing");
			let provenance = create({ lane: "stored", name: "sdk-A" });
			await options?.onRequestAttempt?.(provenance, model);
			if (state.callCount === 1) throw new Error("401 unauthorized");
			provenance = create({ lane: "stored", name: "sdk-B" });
			await options?.onRequestAttempt?.(provenance, model);
			await options?.onProviderStreamEvent?.({ id: "actual-response" }, model, provenance);
			return { ...fauxAssistantMessage("ok"), requestProvenance: provenance };
		};
		faux.setResponses([serve, serve]);
		let message: AssistantMessage | undefined;
		for await (const event of runtime.streamSimple(
			faux.getModel(),
			{ messages: [] },
			{
				onRequestAttempt: (provenance) => {
					attempts.push(provenance);
				},
				onProviderStreamEvent: (_data, _model, provenance) => {
					raw.push(provenance);
				},
			},
		)) {
			if (event.type === "error") throw new Error(event.error.errorMessage);
			if (event.type === "done") {
				message = event.message;
				break;
			}
		}
		expect(attempts.map((attempt) => attempt.slot?.name)).toEqual(["sdk-A", "sdk-A", "sdk-B"]);
		expect(attempts.map((attempt) => attempt.failoverIndex)).toEqual([0, 0, 1]);
		expect(new Set(attempts.map((attempt) => attempt.requestId)).size).toBe(1);
		expect(new Set(attempts.map((attempt) => attempt.attemptId)).size).toBe(3);
		expect(raw).toEqual([attempts[2]]);
		expect(message?.requestProvenance).toEqual(attempts[2]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
