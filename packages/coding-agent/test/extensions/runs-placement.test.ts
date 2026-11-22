import { type AgentTool, createRemoteToolHost } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { loadExtensions } from "../../src/core/extensions/loader.ts";
import type {
	Extension,
	ExtensionAPI,
	ExtensionFactory,
	ExtensionSide,
	HandlerRegistrationOptions,
} from "../../src/core/extensions/types.ts";
import { cleanupHands, handDirs, openLink, startHand } from "../hand/remote-hand-fixture.ts";
import { EXTENSION_EVENTS_PLANE, serveExtensionEvents } from "../../src/core/extensions/two-sided-forwarding.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import { createTestResourceLoader } from "../utilities.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

/** `undefined` is a fused session: the caller names no side, as every caller does today. */
type LoadSide = ExtensionSide | undefined;

/**
 * Registers one `tool_call` handler on the hand, one `before_agent_start` handler on the brain and one
 * undeclared `tool_result` handler, plus a child-placed tool declared for the hand. With `declare: false`
 * it registers the same handlers with no `runs`, as every extension does today.
 */
function placementFixture(fired: string[], declare: boolean): ExtensionFactory {
	const runs = (side: ExtensionSide): HandlerRegistrationOptions | undefined => (declare ? { runs: side } : undefined);
	return (pi: ExtensionAPI) => {
		pi.on(
			"tool_call",
			(event) => {
				fired.push(`tool_call ${event.toolName}`);
			},
			runs("hand"),
		);
		pi.on(
			"before_agent_start",
			() => {
				fired.push("before_agent_start");
			},
			runs("brain"),
		);
		pi.on("tool_result", (event) => {
			fired.push(`tool_result ${event.toolName}`);
		});
		pi.registerTool({
			name: "child_echo",
			label: "Child echo",
			description: "Echo on the tool child",
			parameters: Type.Object({}),
			placement: "child",
			...(declare ? { runs: "hand" as const } : {}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
		});
	};
}

async function load(factory: ExtensionFactory, side: LoadSide): Promise<Extension> {
	const result = await loadExtensions(["<runs-fixture>"], process.cwd(), undefined, undefined, {
		...(side === undefined ? {} : { side }),
		factoryResolver: () => factory,
	});
	expect(result.errors).toEqual([]);
	const [extension, ...rest] = result.extensions;
	if (extension === undefined || rest.length > 0) throw new Error("expected exactly one loaded extension");
	return extension;
}

async function runOneTurn(declare: boolean, side: LoadSide): Promise<string[]> {
	const fired: string[] = [];
	const echoTool: AgentTool = {
		name: "echo",
		label: "Echo",
		description: "Echo the arguments back",
		parameters: Type.Object({}, { additionalProperties: true }),
		execute: async (_toolCallId, params) => ({
			content: [{ type: "text", text: JSON.stringify(params) }],
			details: {},
		}),
	};
	const extensionsResult = await loadExtensions(["<runs-fixture>"], process.cwd(), undefined, undefined, {
		...(side === undefined ? {} : { side }),
		factoryResolver: () => placementFixture(fired, declare),
	});
	expect(extensionsResult.errors).toEqual([]);
	const harness = await createHarness({
		tools: [echoTool],
		resourceLoader: createTestResourceLoader({ extensionsResult }),
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("echo", { n: 1 })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("call echo");
	return fired;
}

function registeredEvents(extension: Extension): Array<[string, number]> {
	return [...extension.handlers].map(([event, handlers]) => [event, handlers.length]);
}

describe("runs: placement of extension registrations (R24.a)", () => {
	it("a handler declared runs: hand fires only in the hand's generation, one declared runs: brain only in the brain's", async () => {
		// Given one extension with a hand tool_call handler, a brain before_agent_start handler and an undeclared tool_result handler.
		// When each side's generation runs the same turn that calls echo once.
		const onHand = await runOneTurn(true, "hand");
		const onBrain = await runOneTurn(true, "brain");

		// Then each declared handler fires only on its own side, and the undeclared one fires on both, as today.
		expect(onHand).toEqual(["tool_call echo", "tool_result echo"]);
		expect(onBrain).toEqual(["before_agent_start", "tool_result echo"]);
	});

	it("a fused session (no side named) fires every handler exactly as an extension that declares nothing", async () => {
		// Given the same extension with and without runs declarations, loaded with no side named.
		const declared = await runOneTurn(true, undefined);
		const undeclared = await runOneTurn(false, undefined);

		// Then both fire the same handlers in the same order: runs changes nothing on a fused session.
		expect(declared).toEqual(["before_agent_start", "tool_call echo", "tool_result echo"]);
		expect(declared).toEqual(undeclared);
	});

	it("an extension that declares nothing registers the same handlers and tools on brain, hand and fused", async () => {
		const fused = await load(placementFixture([], false), undefined);
		const brain = await load(placementFixture([], false), "brain");
		const hand = await load(placementFixture([], false), "hand");

		expect(registeredEvents(brain)).toEqual(registeredEvents(fused));
		expect(registeredEvents(hand)).toEqual(registeredEvents(fused));
		expect([...brain.tools.keys()]).toEqual([...fused.tools.keys()]);
		expect([...hand.tools.keys()]).toEqual([...fused.tools.keys()]);
		expect(fused.handlerSides).toBeUndefined();
		expect(brain.handlerSides).toBeUndefined();
		expect(hand.handlerSides).toBeUndefined();
	});

	it("records the declared side of each handler and keeps registration order among one side's handlers", async () => {
		const order: string[] = [];
		const factory: ExtensionFactory = (pi) => {
			pi.on("tool_call", () => void order.push("a"), { runs: "hand" });
			pi.on("tool_call", () => void order.push("b"));
			pi.on("tool_call", () => void order.push("c"), { runs: "brain" });
			pi.on("tool_call", () => void order.push("d"), { runs: "hand" });
		};

		const fused = await load(factory, undefined);
		const hand = await load(factory, "hand");
		const brain = await load(factory, "brain");

		const sides = (extension: Extension) =>
			(extension.handlers.get("tool_call") ?? []).map((handler) => extension.handlerSides?.get(handler) ?? "-");
		expect(sides(fused)).toEqual(["hand", "-", "brain", "hand"]);
		expect(sides(hand)).toEqual(["hand", "-", "hand"]);
		expect(sides(brain)).toEqual(["-", "brain"]);

		const event = { type: "tool_call", toolCallId: "t1", toolName: "echo", input: {} };
		for (const handler of hand.handlers.get("tool_call") ?? []) await handler(event, undefined);
		expect(order).toEqual(["a", "b", "d"]);
	});

	it("runs on a tool never changes its child placement, and the tool registers on every side", async () => {
		for (const side of [undefined, "brain", "hand"] as const) {
			const extension = await load(placementFixture([], true), side);
			const definition = extension.tools.get("child_echo")?.definition;
			expect(definition?.placement).toBe("child");
			expect(definition?.runs).toBe("hand");
		}
		const undeclared = await load(placementFixture([], false), undefined);
		expect(undeclared.tools.get("child_echo")?.definition.placement).toBe("child");
		expect(undeclared.tools.get("child_echo")?.definition.runs).toBeUndefined();
	});

	it("a runs value outside brain | hand fails the extension load", async () => {
		const badHandler: ExtensionFactory = (pi) => {
			// @ts-expect-error runs accepts only "brain" | "hand".
			pi.on("tool_call", () => {}, { runs: "edge" });
		};
		const badTool: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "bad_tool",
				label: "Bad",
				description: "Bad runs",
				parameters: Type.Object({}),
				// @ts-expect-error runs accepts only "brain" | "hand".
				runs: "edge",
				execute: async () => ({ content: [], details: undefined }),
			});
		};

		for (const factory of [badHandler, badTool]) {
			const result = await loadExtensions(["<runs-fixture>"], process.cwd(), undefined, undefined, {
				factoryResolver: () => factory,
			});
			expect(result.extensions).toEqual([]);
			expect(result.errors).toEqual([
				{ path: "<runs-fixture>", error: expect.stringContaining('runs must be "brain" or "hand"') },
			]);
		}
	});
});

describe("runs: on split-local, through the hand that executes the session's calls", () => {
	afterEach(cleanupHands);

	async function splitLocalTurn(declare: boolean): Promise<{ fired: string[]; results: string[] }> {
		const fired: string[] = [];
		const dirs = await handDirs("runs");
		const link = openLink();
		startHand(link, dirs, [placementFixture(fired, declare)]);
		// The brain is a real session with the same extension loaded on its side, as on a split session: a two-sided
		// extension's forwarded tool events run there (S29).
		const harness = await createHarness({ extensionFactories: [placementFixture(fired, declare)] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.agent.toolHost = createRemoteToolHost({
			transport: link.brain,
			placement: "split-local",
			planes: { [EXTENSION_EVENTS_PLANE]: serveExtensionEvents(harness.getExtensionRunner()) },
		});
		harness.setResponses([
			fauxAssistantMessage([{ ...fauxToolCall("child_echo", {}), id: "call-1" }], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		const results = harness.session.messages.flatMap((message) =>
			message.role === "toolResult"
				? [message.content.map((part) => (part.type === "text" ? part.text : "")).join("")]
				: [],
		);
		return { fired, results };
	}

	it("a tool_call handler declared runs: hand runs on the hand for the call it executes", async () => {
		const { fired, results } = await splitLocalTurn(true);

		expect(fired).toEqual(["before_agent_start", "tool_call child_echo", "tool_result child_echo"]);
		expect(results).toEqual(["ok"]);
	});

	it("an extension with runs declarations behaves exactly as the same extension without them", async () => {
		const declared = await splitLocalTurn(true);
		const undeclared = await splitLocalTurn(false);

		expect(declared).toEqual(undeclared);
	});
});
