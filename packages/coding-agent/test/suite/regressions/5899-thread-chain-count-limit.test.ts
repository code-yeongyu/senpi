import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { InputEvent } from "../../../src/core/extensions/types.ts";
import { ControlAttachments } from "../../../src/modes/interactive/session-control-attach.ts";
import { runTuiRpcCommand } from "../../../src/modes/interactive/session-control-rpc-commands.ts";
import type { ControlConnection } from "../../../src/modes/interactive/session-control-server.ts";
import { makeSink } from "../rpc-connection-harness.ts";
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
		return { fixture, rpc: fixture.bind(), inputs };
	};

	type Entry = (
		setupResult: Awaited<ReturnType<typeof setup>>,
		command: { readonly type: string } & Record<string, unknown>,
	) => Promise<Record<string, unknown>>;
	// Every entry that accepts a prompt, steer or follow_up for a session (senpi#5923 review): a plain RPC connection, an
	// RPC connection while a hold keeps automatic input as a notice, and a terminal's session-control endpoint.
	const ENTRIES: ReadonlyArray<readonly [string, Entry]> = [
		["a plain RPC connection", ({ rpc }, command) => rpc.send(command)],
		[
			"an RPC connection while a run hold keeps automatic input as a notice",
			async ({ fixture, rpc }, command) => {
				fixture.session.pauseForRun({
					parentSessionId: "parent",
					parentPauseSeq: 1,
					runRef: { kind: "task", id: "r1" },
				});
				return rpc.send(command);
			},
		],
		[
			"a terminal's session-control endpoint",
			async ({ fixture }, command) => {
				const attachments = new ControlAttachments(fixture.session, () => 0);
				const connection: ControlConnection = { id: 1, transport: makeSink().sink, send: () => {} };
				const answer = await runTuiRpcCommand(
					{ instanceId: "tui", session: fixture.session, attachments },
					connection,
					{
						...command,
						id: "t-1",
					},
				);
				return (answer ?? {}) as Record<string, unknown>;
			},
		],
	];

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

	describe.each(ENTRIES)("through %s", (_name, send) => {
		it.each(["prompt", "steer", "follow_up"])(
			"refuses %s call N+1 before anything of it runs or is held",
			async (type) => {
				const ready = await setup({ threads: { chainCountLimit: 2 } });

				const response = await send(ready, { type, message: "from B", chainCount: 3 });

				expect(response.success).toBe(false);
				expect(response.heldAsNotice).toBeUndefined();
				expect(ready.inputs).toEqual([]);
				expect(ready.fixture.session.messages.filter((message) => message.role === "user")).toEqual([]);
			},
		);
	});

	describe.each(ENTRIES)("through %s", (_name, send) => {
		it.each([null, 0, -3, 1.5, "abc", Number.MAX_SAFE_INTEGER + 1])(
			"refuses a malformed chainCount %j before anything of it runs or is held",
			async (chainCount) => {
				const ready = await setup({});

				const response = await send(ready, { type: "prompt", message: "from B", chainCount });

				expect(response.success).toBe(false);
				expect(response.heldAsNotice).toBeUndefined();
				expect(ready.inputs).toEqual([]);
			},
		);
	});

	it("names the typed reason on a malformed chainCount refusal", async () => {
		const { rpc } = await setup({});

		const response = await rpc.send({ type: "steer", message: "from B", chainCount: -3 });

		expect(response).toMatchObject({ errorCode: "invalid_chain_count", errorData: { chainCount: -3 } });
	});

	it("names the typed reason and the count on an RPC refusal", async () => {
		const { rpc } = await setup({ threads: { chainCountLimit: 2 } });

		const response = await rpc.send({ type: "prompt", message: "from B", chainCount: 3 });

		expect(response).toMatchObject({ errorCode: "chain_count_limit", errorData: { count: 3, limit: 2 } });
	});

	it("leaves an input that is not a thread call without a chain count", async () => {
		const { rpc, inputs } = await setup({ threads: { chainCountLimit: 2 } });

		const response = await rpc.send({ type: "prompt", message: "from a person" });

		expect(response).toMatchObject({ success: true });
		expect(inputs.map((event) => event.chainCount)).toEqual([undefined]);
	});
});
