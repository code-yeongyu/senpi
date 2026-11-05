import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { InputEvent } from "../../../src/core/extensions/types.ts";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";

// senpi#5899 (S32, decision K8): a thread call from another session arrives as RPC input carrying its chain's hop
// count. The host admits it against the user's `threads.chainCountLimit`, read from the settings file: with no limit
// set any length is admitted, and with a limit N call N+1 is refused with the typed reason `chain_count_limit` before
// anything of it runs. An admitted count reaches the session's `input` event so its own thread calls can carry one more.
describe("thread chain count limit at RPC input admission", () => {
	const fixtures: Awaited<ReturnType<typeof createIdentityHarness>>[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) await fixture.cleanup();
	});

	const setup = async (settings: Record<string, unknown>) => {
		const inputs: InputEvent[] = [];
		const fixture = await createIdentityHarness({
			fileSettings: true,
			settings,
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						inputs.push(event);
						return { action: "continue" };
					});
				},
			],
		});
		fixtures.push(fixture);
		fixture.harness.setResponses([fauxAssistantMessage("answered")]);
		return { rpc: fixture.bind(), inputs };
	};

	it("admits a 12-hop thread call when the user set no count limit", async () => {
		const { rpc, inputs } = await setup({});

		const response = await rpc.send({ type: "prompt", message: "from B", chainCount: 12 });

		expect(response).toMatchObject({ success: true });
		expect(inputs.map((event) => event.chainCount)).toEqual([12]);
	});

	it("admits call N under a user-set count limit N", async () => {
		const { rpc, inputs } = await setup({ threads: { chainCountLimit: 2 } });

		const response = await rpc.send({ type: "prompt", message: "from B", chainCount: 2 });

		expect(response).toMatchObject({ success: true });
		expect(inputs.map((event) => event.chainCount)).toEqual([2]);
	});

	it.each(["prompt", "steer", "follow_up"])(
		"refuses %s call N+1 with chain_count_limit before anything of it runs",
		async (type) => {
			const { rpc, inputs } = await setup({ threads: { chainCountLimit: 2 } });

			const response = await rpc.send({ type, message: "from B", chainCount: 3 });

			expect(response).toMatchObject({
				success: false,
				errorCode: "chain_count_limit",
				errorData: { count: 3, limit: 2 },
			});
			expect(inputs).toEqual([]);
		},
	);

	it("leaves an input that is not a thread call without a chain count", async () => {
		const { rpc, inputs } = await setup({ threads: { chainCountLimit: 2 } });

		const response = await rpc.send({ type: "prompt", message: "from a person" });

		expect(response).toMatchObject({ success: true });
		expect(inputs.map((event) => event.chainCount)).toEqual([undefined]);
	});
});
