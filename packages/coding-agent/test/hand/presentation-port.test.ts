// S30 (brain/hand split, F12/F39): the presentation port. On a split session, the UI an extension produces on the hand
// (widgets, notices, status, titles, editor text, ...) is presented by the UI of the session the client is attached to,
// with the same calls, content and order as on a fused session. Dialogs are not the port's: they stay on the UI broker
// and the remote dialog path. A fused session never builds the port.
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import { createRemoteToolHost } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { noOpUIContext } from "../../src/core/extensions/runner.ts";
import type { ExtensionFactory, ExtensionUIContext } from "../../src/core/extensions/types.ts";
import {
	openPresentationPort,
	servePresentation,
	UI_PRESENTATION_PLANE,
} from "../../src/core/extensions/ui-presentation.ts";
import { cleanupHands, handDirs, openLink, startHand } from "./remote-hand-fixture.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	await cleanupHands();
});

type Call = readonly [method: string, ...args: unknown[]];

const KINDS: readonly Call[] = [
	["notify", "a notice", "warning"],
	["setStatus", "key", "text"],
	["setStatus", "key", undefined],
	["setSubagentCost", 0.25],
	["setWorkingMessage", "thinking hard"],
	["setWorkingVisible", false],
	["setWorkingIndicator", { frames: ["-", "+"], intervalMs: 80 }],
	["setHiddenThinkingLabel", "pondering"],
	["setWidget", "panel", ["line 1", "line 2"], { placement: "aboveEditor" }],
	["setWidget", "panel", undefined],
	["setTitle", "a title"],
	["setProgramStatus", undefined],
	["pasteToEditor", "pasted"],
	["setEditorText", "replaced"],
	["setToolsExpanded", true],
];

/** The attached client's UI: records every call it is asked to present, in order. */
function recordingUi(log: unknown[]): ExtensionUIContext {
	const record =
		(method: string) =>
		(...args: unknown[]): void => {
			log.push([method, ...args]);
		};
	return {
		...noOpUIContext,
		notify: record("notify"),
		setStatus: record("setStatus"),
		setSubagentCost: record("setSubagentCost"),
		setWorkingMessage: record("setWorkingMessage"),
		setWorkingVisible: record("setWorkingVisible"),
		setWorkingIndicator: record("setWorkingIndicator"),
		setHiddenThinkingLabel: record("setHiddenThinkingLabel"),
		setWidget: record("setWidget") as ExtensionUIContext["setWidget"],
		setTitle: record("setTitle"),
		setProgramStatus: record("setProgramStatus"),
		pasteToEditor: record("pasteToEditor"),
		setEditorText: record("setEditorText"),
		setToolsExpanded: record("setToolsExpanded"),
		confirm: async (title) => {
			log.push(["confirm", title]);
			return true;
		},
	};
}

const presentTool = (name: string, run: (ui: ExtensionUIContext, params: Record<string, unknown>) => Promise<string>) =>
	({
		name,
		label: name,
		description: `${name} presents UI`,
		parameters: Type.Object({}, { additionalProperties: true }),
		execute: async (
			_id: string,
			params: Record<string, unknown>,
			_signal: unknown,
			_update: unknown,
			ctx: { ui: ExtensionUIContext },
		) => ({
			content: [{ type: "text" as const, text: await run(ctx.ui, params) }],
			details: {},
		}),
	}) as const;

/** Tool-only (so it runs on the hand): presents from its tool_call handler, its tool and its tool_result handler. */
const handPresenter: ExtensionFactory = (pi) => {
	pi.on("tool_call", (event, ctx) => {
		ctx.ui.setStatus("phase", `call ${event.toolCallId}`);
		ctx.ui.setWidget("progress", ["before", event.toolName]);
		return undefined;
	});
	pi.registerTool(
		presentTool("show", async (ui, params) => {
			ui.notify(`running ${JSON.stringify(params)}`, "info");
			ui.setWorkingMessage("working");
			return "shown";
		}),
	);
	pi.registerTool(
		presentTool("present", async (ui, params) => {
			const [method, ...args] = KINDS[Number(params.kind)] ?? ["notify", "no such kind"];
			(ui[method as keyof ExtensionUIContext] as (...args: unknown[]) => unknown)(...args);
			return "presented";
		}),
	);
	pi.registerTool(presentTool("ask", async (ui) => `confirmed=${String(await ui.confirm("Proceed?", "really"))}`));
	pi.registerTool({
		name: "probe",
		label: "probe",
		description: "reports whether the tool sees a UI",
		parameters: Type.Object({}, { additionalProperties: true }),
		execute: async (_id, _params, _signal, _update, ctx) => ({
			content: [{ type: "text", text: `hasUI=${String(ctx.hasUI)}` }],
			details: {},
		}),
	});
	pi.registerTool(
		presentTool("boom", async (ui) => {
			ui.notify("about to fail", "warning");
			throw new Error("tool exploded");
		}),
	);
	pi.on("tool_result", (_event, ctx) => {
		ctx.ui.setWidget("progress", ["after"], { placement: "belowEditor" });
		ctx.ui.setTitle("done");
		return undefined;
	});
};

interface Run {
	readonly log: unknown[];
	readonly results: string[];
	readonly planeMethods: unknown[];
}

async function run(
	placement: "fused" | "split-local",
	calls: readonly [string, JsonObject][],
	brain: { readonly servesPresentation: boolean } = { servesPresentation: true },
): Promise<Run> {
	const harness = await createHarness({ extensionFactories: [handPresenter] });
	harnesses.push(harness);
	const log: unknown[] = [];
	const runner = harness.getExtensionRunner();
	runner.setUIContext(recordingUi(log), "tui");
	const planeMethods: unknown[] = [];
	if (placement === "split-local") {
		const dirs = await handDirs("s30");
		const link = openLink();
		startHand(link, dirs, [handPresenter]);
		const serve = servePresentation(runner);
		harness.agent.toolHost = createRemoteToolHost({
			transport: link.brain,
			placement: "split-local",
			planes: brain.servesPresentation
				? {
						[UI_PRESENTATION_PLANE]: (body, context) => {
							planeMethods.push((body as { method?: unknown }).method);
							return serve(body, context);
						},
					}
				: {},
		});
	}
	harness.agent.subscribe((event) => {
		if (event.type === "tool_execution_end") log.push(["end", event.toolCallId]);
	});
	harness.setResponses([
		fauxAssistantMessage(
			calls.map(([name, args], index) => ({ ...fauxToolCall(name, args), id: `call-${index}` })),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("go");
	const results = harness.session.messages.flatMap((message) =>
		message.role === "toolResult"
			? [message.content.map((part) => (part.type === "text" ? part.text : "")).join("")]
			: [],
	);
	return { log, results, planeMethods };
}

describe("the presentation port presents a hand's extension UI on the attached client (S30)", () => {
	it("presents UI from the hand's tool_call handler, tool and tool_result handler exactly as fused, before the call ends", async () => {
		const calls: [string, JsonObject][] = [["show", { n: 1 }]];
		const fused = await run("fused", calls);

		const split = await run("split-local", calls);

		expect(split.log).toEqual(fused.log);
		expect(split.results).toEqual(fused.results);
		expect(fused.log).toEqual([
			["setStatus", "phase", "call call-0"],
			["setWidget", "progress", ["before", "show"]],
			["notify", 'running {"n":1}', "info"],
			["setWorkingMessage", "working"],
			["setWidget", "progress", ["after"], { placement: "belowEditor" }],
			["setTitle", "done"],
			["end", "call-0"],
		]);
	});

	it.each(KINDS.map((call, kind) => [call[0], kind, call] as const))(
		"presents %s (case %i) from the hand once, with the same content as fused",
		async (_method, kind, call) => {
			const calls: [string, JsonObject][] = [["present", { kind }]];
			const fused = await run("fused", calls);

			const split = await run("split-local", calls);

			expect(split.log).toEqual(fused.log);
			expect(fused.log.filter((entry) => JSON.stringify(entry) === JSON.stringify(call))).toHaveLength(1);
			expect(fused.log).toContainEqual([...call]);
		},
	);

	it("keeps dialogs off the port: a hand's confirm is not presented through it", async () => {
		const split = await run("split-local", [["ask", {}]]);

		expect(split.log).not.toContainEqual(["confirm", "Proceed?"]);
		expect(split.results).toEqual(["confirmed=false"]);
		expect(split.planeMethods).not.toContain("confirm");
		expect(split.planeMethods).toEqual(["setStatus", "setWidget", "setWidget", "setTitle"]);
	});

	it("the port does not make the hand claim a UI: hasUI stays as it was without the port", async () => {
		const split = await run("split-local", [["probe", {}]]);

		expect(split.results).toEqual(["hasUI=false"]);
		expect(split.planeMethods).toEqual(["setStatus", "setWidget", "setWidget", "setTitle"]);
	});

	it("a call whose presentations cannot be delivered still returns its own result", async () => {
		const fused = await run("fused", [["show", { n: 1 }]]);

		const split = await run("split-local", [["show", { n: 1 }]], { servesPresentation: false });

		expect(split.results).toEqual(fused.results);
		expect(split.results).toEqual(["shown"]);
	});

	it("a failing tool whose presentations cannot be delivered keeps its own error", async () => {
		const fused = await run("fused", [["boom", {}]]);

		const split = await run("split-local", [["boom", {}]], { servesPresentation: false });

		expect(fused.results[0]).toContain("tool exploded");
		expect(split.results).toHaveLength(1);
		expect(split.results[0]).toContain("tool exploded");
		expect(split.results[0]).not.toMatch(/presentation|refused|plane_unavailable/);
	});

	it("fused: presents directly, and the port is never used", async () => {
		const fused = await run("fused", [["show", { n: 1 }]]);

		expect(fused.planeMethods).toEqual([]);
		expect(fused.log).toContainEqual(["notify", 'running {"n":1}', "info"]);
	});
});

describe("one call's presentation port (S30)", () => {
	const port = (options: { readonly fail?: boolean } = {}) => {
		const sent: unknown[] = [];
		const base: unknown[] = [];
		const undelivered: unknown[] = [];
		const opened = openPresentationPort(
			async (_plane, body) => {
				if (options.fail === true) throw new Error("plane_unavailable");
				sent.push(body);
				return null;
			},
			recordingUi(base),
			(error) => void undelivered.push(error instanceof Error ? error.message : error),
		);
		return { ...opened, sent, base, undelivered };
	};

	it("sends presentations in order and keeps undefined arguments", async () => {
		const p = port();
		p.ui.setStatus("key", "a");
		p.ui.setStatus("key", undefined);
		await p.close();

		expect(p.sent).toEqual([
			{ method: "setStatus", args: ["key", "a"] },
			{ method: "setStatus", args: ["key", { $undefined: true }] },
		]);
	});

	it("presents on the hand's own UI after the call ended", async () => {
		const p = port();
		await p.close();
		p.ui.notify("late", "info");

		expect(p.sent).toEqual([]);
		expect(p.base).toEqual([["notify", "late", "info"]]);
	});

	it("keeps content that does not survive the plane on the hand's own UI, without throwing", async () => {
		const p = port();
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const factory = () => ({ render: () => [], invalidate: () => {} });
		p.ui.setWidget("component", factory as unknown as string[]);
		p.ui.setWorkingIndicator(cyclic as never);
		p.ui.setSubagentCost?.(Number.NaN);
		p.ui.setWidget("dated", [new Date(0) as unknown as string]);
		await p.close();

		expect(p.sent).toEqual([]);
		expect(p.base.map((entry) => (entry as unknown[])[0])).toEqual([
			"setWidget",
			"setWorkingIndicator",
			"setSubagentCost",
			"setWidget",
		]);
	});

	it("answers dialogs from the hand's own UI", async () => {
		const p = port();

		expect(await p.ui.confirm("Proceed?", "really")).toBe(true);
		await p.close();
		expect(p.sent).toEqual([]);
		expect(p.base).toEqual([["confirm", "Proceed?"]]);
	});

	it("reports an undeliverable presentation on its own channel and never fails the call", async () => {
		const p = port({ fail: true });
		p.ui.notify("one", "info");
		p.ui.notify("two", "info");

		await expect(p.close()).resolves.toBeUndefined();
		expect(p.undelivered).toEqual(["plane_unavailable"]);
		expect(p.base).toEqual([
			["notify", "one", "info"],
			["notify", "two", "info"],
		]);
	});
});

describe("the presentation port during a device file operation (S30 with S40)", () => {
	it("presents UI from the hand's tool_call handler that checks a file operation on the attached client", async () => {
		const harness = await createHarness({ extensionFactories: [handPresenter] });
		harnesses.push(harness);
		const log: unknown[] = [];
		const runner = harness.getExtensionRunner();
		runner.setUIContext(recordingUi(log), "tui");
		const dirs = await handDirs("s30-file");
		const link = openLink();
		startHand(link, dirs, [handPresenter]);
		const host = createRemoteToolHost({
			transport: link.brain,
			placement: "split-local",
			planes: { [UI_PRESENTATION_PLANE]: servePresentation(runner) },
			filePlanes: [UI_PRESENTATION_PLANE],
		});
		const root = realpathSync(dirs.cwd);
		writeFileSync(join(root, "note.md"), "from the device");

		await host.deviceFiles({ id: "s30-file-scope", root }).read(join(root, "note.md"));

		expect(log).toEqual([
			["setStatus", "phase", expect.stringMatching(/^call file-/)],
			["setWidget", "progress", ["before", "read"]],
		]);
	});
});
