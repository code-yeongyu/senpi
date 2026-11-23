import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { serveExtensionEvents } from "../../../src/core/extensions/two-sided-forwarding.ts";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import type { ToolCallReadyEvent } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#7232 review M1: an observer had no way to learn the path a model write runs with after a tool_call handler
// redirected it, before the tool writes it.
describe("tool_call_ready (senpi#7232)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	/** A session whose `probe` tool records the arguments it runs with; `observe` subscribes to the event. */
	async function probeSession(
		factories: readonly ExtensionFactory[],
		observe: (event: ToolCallReadyEvent) => unknown,
	) {
		const executed: unknown[] = [];
		const ready: ToolCallReadyEvent[] = [];
		const harness = await createHarness({
			extensionFactories: [
				...factories,
				(pi) => {
					pi.on("tool_call_ready", async (event) => {
						ready.push(structuredClone(event));
						await observe(event);
					});
					pi.registerTool({
						name: "probe",
						label: "Probe",
						description: "Records the arguments it runs with",
						parameters: Type.Object({}, { additionalProperties: true }),
						async execute(_toolCallId, input) {
							executed.push(structuredClone(input));
							return { content: [{ type: "text", text: "ok" }], details: {} };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		const calls = (...args: JsonObject[]) =>
			harness.setResponses([
				...args.map((input, index) =>
					fauxAssistantMessage(fauxToolCall("probe", input, { id: `call-${index}` }), { stopReason: "toolUse" }),
				),
				fauxAssistantMessage("done"),
			]);
		return { harness, executed, ready, calls };
	}

	const redirecting: ExtensionFactory = (pi) => {
		pi.on("tool_call", (event) => {
			if (Reflect.get(event.input, "path") === "blocked.ts") return { block: true, reason: "not this one" };
			Reflect.set(event.input, "path", "redirected.ts");
			return undefined;
		});
	};

	it("carries the redirected arguments before the tool runs, and is not fired for a blocked call", async () => {
		const session = await probeSession([redirecting], () => undefined);
		session.calls({ path: "requested.ts" }, { path: "blocked.ts" });

		await session.harness.session.prompt("probe twice");

		expect({
			ready: session.ready.map((event) => [event.toolCallId, event.input]),
			executed: session.executed,
		}).toEqual({ ready: [["call-0", { path: "redirected.ts" }]], executed: [{ path: "redirected.ts" }] });
	});

	// Review L1: the copy was shallow, so a change to a nested argument reached the call.
	it("hands observers a copy: no change they make, nested or not, reaches the call", async () => {
		const passThrough: ExtensionFactory = (pi) => {
			pi.on("tool_call", () => undefined);
		};
		const session = await probeSession([passThrough], (event) => {
			Reflect.set(event.input, "path", "tampered.ts");
			const edits = Reflect.get(event.input, "edits");
			if (Array.isArray(edits)) edits.push({ oldText: "x", newText: "tampered" });
		});
		session.calls({ path: "a.ts", edits: [{ oldText: "a", newText: "b" }] });

		await session.harness.session.prompt("probe");

		expect({ observed: session.ready.length, executed: session.executed }).toEqual({
			observed: 1,
			executed: [{ path: "a.ts", edits: [{ oldText: "a", newText: "b" }] }],
		});
	});

	// Review M2: with no tool_call handler registered the event was never fired.
	it("is fired for a call no tool_call handler was asked about", async () => {
		const session = await probeSession([], () => undefined);
		session.calls({ path: "a.ts" });

		await session.harness.session.prompt("probe");

		expect(session.ready.map((event) => [event.toolCallId, event.toolName, event.input])).toEqual([
			["call-0", "probe", { path: "a.ts" }],
		]);
	});

	// Review M1: serving one forwarded tool_call handler where the loop runs is part of a chain that ends on the hand.
	it("is not fired where the loop serves one forwarded tool_call handler", async () => {
		const session = await probeSession([redirecting], () => undefined);
		const runner = session.harness.getExtensionRunner();
		const [extension] = runner.getExtensionPaths();
		if (extension === undefined) throw new Error("no extension loaded");

		const answer = await serveExtensionEvents(runner)(
			{
				extension,
				handler: 0,
				event: "tool_call",
				payload: { type: "tool_call", toolName: "probe", toolCallId: "forwarded", input: { path: "a.ts" } },
			},
			new AbortController().signal,
		);

		expect({ answer, ready: session.ready }).toEqual({
			answer: expect.objectContaining({ input: { path: "redirected.ts" } }),
			ready: [],
		});
	});

	// Review L2: an observer that never returned held the call after Stop.
	it("lets Stop end the wait on an observer that never returns, and the call does not run", async () => {
		let entered: () => void = () => {};
		const observing = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const session = await probeSession([redirecting], () => {
			entered();
			return new Promise<never>(() => {});
		});
		session.calls({ path: "a.ts" });

		const prompted = session.harness.session.prompt("probe");
		await observing;
		await session.harness.session.abort();
		await prompted;

		expect({ ready: session.ready.length, executed: session.executed }).toEqual({ ready: 1, executed: [] });
	});
});
