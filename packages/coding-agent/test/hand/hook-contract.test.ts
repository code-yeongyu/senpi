// CK21 (hosted model-key custody): the request-hook contract. `HookModelRequestInput` is the serializable projection of
// the fused `before_provider_request` input, pinned by a golden; a hand serves `hook.model_request` by running its user
// hooks on that input after the placement claim verifies; aux calls get no hook input.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	CLAIM_VERDICT_ERRORS,
	type ClaimVerdict,
	type SignedPlacementClaim,
} from "../../src/core/egress/placement-claim.ts";
import type { HookModelRequest, ProviderCallKind } from "../../src/core/egress/wire.ts";
import type { BeforeProviderRequestEvent, ExtensionFactory } from "../../src/core/extensions/types.ts";
import {
	HookContractError,
	HookRequestRefusedError,
	hookRequestInputForCall,
	hookRequestInputOf,
	loopHookRequestHooks,
	parseHookRequestInput,
	serveHookModelRequest,
} from "../../src/core/hand/hook-contract.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import { createLoopHookCall, extensionLoopHooks } from "../../src/modes/rpc/loopless-tool-handlers.ts";
import { createLooplessHand } from "../../src/modes/rpc/remote-executor-scope.ts";
import { createInMemoryModelRegistry } from "../model-runtime-test-utils.ts";
import { createTestExtensionsResult } from "../utilities.ts";
import { cleanupHands, handConfiguration, handDirs } from "./remote-hand-fixture.ts";
import { fusedDispatch, REQUEST_HEADERS, REQUEST_MODEL, REQUEST_PAYLOAD } from "./hook-request-fixture.ts";

const GOLDEN = JSON.parse(
	readFileSync(new URL("./fixtures/hook-model-request-input.golden.json", import.meta.url), "utf8"),
) as JsonValue;

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
	await cleanupHands();
});

const STEP: ProviderCallKind = { kind: "step", stepId: "step-1", attempt: 0 };
const AUX_KINDS = ["stream", "warm", "compact-endpoint"] as const;
const CLAIM = {
	claim: { placementId: "p" },
	sig: { keyId: "k", sig: "s", alg: "ES256" },
} as unknown as SignedPlacementClaim;

const fusedEvent = (): BeforeProviderRequestEvent => ({
	type: "before_provider_request",
	payload: structuredClone(REQUEST_PAYLOAD),
	model: structuredClone(REQUEST_MODEL),
	headers: { ...REQUEST_HEADERS },
});

const request = (input: JsonValue, sessionId = "loop-session"): HookModelRequest => ({
	t: "hook.model_request",
	sessionId,
	stepId: "step-1",
	claim: CLAIM,
	input,
});

/** The recording user extension the hand loads by path, as a user's own extension file. */
const RECORDING_EXTENSION = `export default (pi) => {
	pi.on("before_provider_request", (event) => {
		(globalThis.ck21Seen ??= []).push(structuredClone(event));
		return { ...event.payload, max_tokens: 2048 };
	});
};`;

async function startHookHand(prefix: string) {
	const dirs = await handDirs(prefix);
	const extension = join(dirs.scratch, "ck21-recording-ext.ts");
	writeFileSync(extension, RECORDING_EXTENSION);
	const hand = createLooplessHand(handConfiguration(dirs, ["-e", extension]), { twoSidedHome: "hand" });
	closers.push(() => hand.close());
	Object.assign(globalThis, { ck21Seen: [] });
	return { dirs, hand, seen: () => (globalThis as { ck21Seen?: BeforeProviderRequestEvent[] }).ck21Seen ?? [] };
}

describe("CK21: the HookModelRequestInput golden", () => {
	it("is the projection of the fused input: payload and effective model, never headers or model headers", async () => {
		const { seen } = await fusedDispatch((seen) => (pi) => {
			pi.on("before_provider_request", (event) => void seen.push(structuredClone(event)));
		});
		const fused = seen[0];
		if (fused === undefined) throw new Error("the fused dispatch ran no hook");

		const input = hookRequestInputOf(fused);

		expect(input).toEqual(GOLDEN);
		expect(JSON.stringify(input)).not.toContain("header-sentinel");
		expect(Object.keys(input)).toEqual(["payload", "model"]);
	});

	it("omits the model when the fused input has none", () => {
		const { model: _model, headers: _headers, ...bare } = fusedEvent();
		expect(hookRequestInputOf(bare)).toEqual({ payload: REQUEST_PAYLOAD });
	});

	it("refuses a payload that is not JSON instead of sending a lossy copy", () => {
		for (const payload of [
			{ f: () => 1 },
			{ n: Number.NaN },
			{ b: 1n },
			{ d: new Date(0) },
			{ u: new Uint8Array(2) },
		])
			expect(() => hookRequestInputOf({ ...fusedEvent(), payload })).toThrow(HookContractError);
	});

	it("reads back only a closed envelope", () => {
		expect(parseHookRequestInput(GOLDEN)).toEqual(GOLDEN);
		for (const bad of [
			null,
			[],
			{},
			{ model: (GOLDEN as { model: JsonValue }).model },
			{ payload: {}, extra: 1 },
			{ payload: {}, model: "m" },
			{ payload: {}, model: { id: "m" } },
			{ payload: {}, model: { ...(GOLDEN as { model: object }).model, headers: { a: "b" } } },
		])
			expect(() => parseHookRequestInput(bad)).toThrow(HookContractError);
	});
});

describe("CK21: no hook input for aux calls", () => {
	it("gives a step call the projection and every aux kind none", () => {
		expect(hookRequestInputForCall(STEP, fusedEvent())).toEqual(GOLDEN);
		for (const auxKind of AUX_KINDS)
			expect(
				hookRequestInputForCall({ kind: "aux", auxId: "a1", streamKind: "title", auxKind }, fusedEvent()),
			).toBeUndefined();
	});
});

describe("CK21: a hand serves hook.model_request", () => {
	it("runs the user's request hook on the hand with exactly the fused input, and replies with its output", async () => {
		const { seen: fusedSeen } = await fusedDispatch((seen) => (pi) => {
			pi.on("before_provider_request", (event) => void seen.push(structuredClone(event)));
		});
		const { dirs, hand, seen } = await startHookHand("ck21-serve");
		const verified: unknown[] = [];

		const reply = await serveHookModelRequest(request(GOLDEN), {
			verifyClaim: async (claim) => {
				verified.push(claim);
				return "valid";
			},
			runRequestHooks: loopHookRequestHooks(hand.loopHooks, { id: "scope-1", root: dirs.cwd }),
		});

		const handEvent = seen()[0];
		const fused = fusedSeen[0];
		expect(seen()).toHaveLength(1);
		expect(handEvent?.payload).toEqual(fused?.payload);
		expect(handEvent?.model).toEqual({ ...REQUEST_MODEL, headers: undefined });
		expect(handEvent?.model).toEqual({ ...fused?.model, headers: undefined });
		expect(verified).toEqual([CLAIM]);
		expect(reply).toEqual({
			t: "hook.model_request.reply",
			sessionId: "loop-session",
			stepId: "step-1",
			output: { payload: { ...REQUEST_PAYLOAD, max_tokens: 2048 }, model: (GOLDEN as { model: JsonValue }).model },
		});
	});

	it("runs only the user's hooks there, never a builtin's (those run where the loop runs)", async () => {
		const builtin: ExtensionFactory = (pi) =>
			void pi.on("before_provider_request", (event) => ({ ...(event.payload as object), builtinRan: true }));
		const user: ExtensionFactory = (pi) =>
			void pi.on("before_provider_request", (event) => ({ ...(event.payload as object), userRan: true }));
		const loaded = await createTestExtensionsResult([
			{ path: "<builtin:ck21-probe>", factory: builtin },
			{ path: "/user/ck21-user.ts", factory: user },
		]);
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			process.cwd(),
			undefined,
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
			loaded.eventBus,
		);
		const hooks = extensionLoopHooks(runner, "hand", process.cwd(), createLoopHookCall());

		const reply = await hooks("before_provider_request", { sessionId: "loop-session", idle: false, input: GOLDEN });

		expect(reply).toEqual({
			output: {
				payload: { ...REQUEST_PAYLOAD, userRan: true },
				model: (GOLDEN as { model: JsonValue }).model,
			},
		});
	});

	it("refuses every claim that does not verify, with its wire code, before any hook runs", async () => {
		for (const verdict of ["invalid", "malformed", "expired", "superseded", "unknown"] as const) {
			let ran = 0;
			const served = serveHookModelRequest(request(GOLDEN), {
				verifyClaim: async (): Promise<ClaimVerdict> => verdict,
				runRequestHooks: async (_sessionId, input) => {
					ran++;
					return input;
				},
			});
			await expect(served).rejects.toBeInstanceOf(HookRequestRefusedError);
			await expect(served).rejects.toMatchObject({ verdict, ...CLAIM_VERDICT_ERRORS[verdict] });
			expect(ran).toBe(0);
		}
	});

	it("refuses a malformed input after the claim verifies, without running a hook", async () => {
		let ran = 0;
		await expect(
			serveHookModelRequest(request({ payload: {}, extra: true }), {
				verifyClaim: async () => "valid",
				runRequestHooks: async (_sessionId, input) => {
					ran++;
					return input;
				},
			}),
		).rejects.toBeInstanceOf(HookContractError);
		expect(ran).toBe(0);
	});
});
