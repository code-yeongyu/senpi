// C5.c (S26b): a dialog an extension raises on a hand while it runs a call (select, confirm, input: a permission prompt,
// an MCP elicitation, a sign-in code) becomes a pending dialog of the session that owns the call. Whoever answers it
// there first (the attached client, another session or agent over RPC) settles it, the answer reaches the hand, and every
// later answer is refused. The hand's timeout and abort settle it with the dialog's default.
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import { createRemoteToolHost, UI_DIALOG_PLANE } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory, ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { servePresentation, UI_PRESENTATION_PLANE } from "../../src/core/extensions/ui-presentation.ts";
import { serveDialog } from "../../src/core/extensions/ui-remote-dialog.ts";
import { createRpcUiPresenter } from "../../src/core/runtime/ui-broker.ts";
import type { RpcExtensionUIRequest } from "../../src/modes/rpc/rpc-types.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import { cleanupHands, handDirs, openLink, startHand } from "./remote-hand-fixture.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	await cleanupHands();
});

type Ask = (ui: ExtensionUIContext, timeout: number | undefined) => Promise<unknown>;

const ASKS: Readonly<Record<string, Ask>> = {
	select: (ui, timeout) => ui.select("Allow bash?", ["allow", "deny"], { timeout, toolCallId: "perm-1" }),
	confirm: (ui, timeout) => ui.confirm("Proceed?", "really", { timeout }),
	input: (ui, timeout) => ui.input("Sign-in code", "XXXX-XXXX", { timeout }),
};

/** Tool-only, so it runs on the hand: asks one dialog and reports the answer and whether it saw a UI. */
const asker: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "ask",
		label: "ask",
		description: "asks a dialog",
		parameters: Type.Object({}, { additionalProperties: true }),
		execute: async (_id, params, _signal, _update, ctx) => {
			const { kind, timeout } = params as { kind: string; timeout?: number };
			const answer = await ASKS[kind]?.(ctx.ui, timeout);
			return {
				content: [{ type: "text", text: `${kind}=${JSON.stringify(answer)} hasUI=${ctx.hasUI}` }],
				details: {},
			};
		},
	});
};

interface Split {
	readonly frames: RpcExtensionUIRequest[];
	readonly raised: (method: string) => Promise<RpcExtensionUIRequest>;
	readonly respond: ReturnType<typeof createRpcUiPresenter>["respond"];
	readonly results: Promise<string[]>;
}

async function split(
	calls: readonly [string, JsonObject][],
	brain: { serves: boolean } = { serves: true },
	handArgs: readonly string[] = [],
): Promise<Split> {
	const harness = await createHarness({ extensionFactories: [asker] });
	harnesses.push(harness);
	const frames: RpcExtensionUIRequest[] = [];
	const waiters: Array<(frame: RpcExtensionUIRequest) => void> = [];
	const presenter = createRpcUiPresenter((frame) => {
		frames.push(frame);
		for (const waiter of [...waiters]) waiter(frame);
	});
	const raised = (method: string): Promise<RpcExtensionUIRequest> => {
		const seen = frames.find((frame) => frame.method === method);
		if (seen !== undefined) return Promise.resolve(seen);
		return new Promise((resolve) => {
			const waiter = (frame: RpcExtensionUIRequest): void => {
				if (frame.method !== method) return;
				waiters.splice(waiters.indexOf(waiter), 1);
				resolve(frame);
			};
			waiters.push(waiter);
		});
	};
	const runner = harness.getExtensionRunner();
	runner.setUIContext(presenter.ui, "rpc");
	const dirs = await handDirs("s26b");
	const link = openLink();
	startHand(link, dirs, [asker], handArgs);
	harness.agent.toolHost = createRemoteToolHost({
		transport: link.brain,
		placement: "split-local",
		planes: {
			[UI_PRESENTATION_PLANE]: servePresentation(runner),
			...(brain.serves ? { [UI_DIALOG_PLANE]: serveDialog(runner) } : {}),
		},
	});
	harness.setResponses([
		fauxAssistantMessage(
			calls.map(([name, args], index) => ({ ...fauxToolCall(name, args), id: `call-${index}` })),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	const results = harness.session
		.prompt("go")
		.then(() =>
			harness.session.messages.flatMap((message) =>
				message.role === "toolResult"
					? [message.content.map((part) => (part.type === "text" ? part.text : "")).join("")]
					: [],
			),
		);
	return { frames, raised, respond: presenter.respond, results };
}

const ANSWERS = {
	select: { value: "allow", text: 'select="allow"' },
	confirm: { confirmed: true, text: "confirm=true" },
	input: { value: "AB12-CD34", text: 'input="AB12-CD34"' },
} as const;

describe("C5.c: a hand's dialog is answered where the session runs (S26b)", () => {
	it.each(Object.keys(ANSWERS) as (keyof typeof ANSWERS)[])(
		"%s raised on the hand reaches the session once, and its answer reaches the hand",
		async (kind) => {
			const run = await split([["ask", { kind }]]);

			const frame = await run.raised(kind);
			const { text, ...answer } = ANSWERS[kind];
			expect(run.respond({ type: "extension_ui_response", id: frame.id, ...answer } as never)).toBe(true);

			expect(await run.results).toEqual([`${text} hasUI=true`]);
			expect(run.frames.filter((candidate) => candidate.method === kind)).toHaveLength(1);
		},
	);

	it.each([
		["the client first", "client"],
		["another agent first", "agent"],
	] as const)("with %s, the first answer settles the dialog and the later one is refused", async (_order, first) => {
		const run = await split([["ask", { kind: "input" }]]);
		const frame = await run.raised("input");
		const answers = { client: "from-client", agent: "from-agent" };
		const second = first === "client" ? "agent" : "client";

		const won = run.respond({ type: "extension_ui_response", id: frame.id, value: answers[first] });
		const lost = run.respond({ type: "extension_ui_response", id: frame.id, value: answers[second] });

		expect([won, lost]).toEqual([true, false]);
		expect(await run.results).toEqual([`input="${answers[first]}" hasUI=true`]);
	});

	it("the hand's timeout settles the dialog with its default, and a later answer is refused", async () => {
		const run = await split([["ask", { kind: "confirm", timeout: 200 }]]);
		const frame = await run.raised("confirm");

		const results = await run.results;

		expect(results).toEqual(["confirm=false hasUI=true"]);
		expect(run.respond({ type: "extension_ui_response", id: frame.id, confirmed: true })).toBe(false);
	});

	it("a session that serves no dialogs leaves them on the hand's own UI, as before", async () => {
		const run = await split([["ask", { kind: "confirm" }]], { serves: false });

		expect(await run.results).toEqual(["confirm=false hasUI=false"]);
		expect(run.frames.filter((frame) => frame.method === "confirm")).toEqual([]);
	});

	it("SC-C5(iv): a permission prompt on the hand is answered where the session runs, and the approved call runs", async () => {
		const run = await split([["bash", { command: "echo hand-ran" }]], { serves: true }, [
			"--permission-preset",
			"ask",
		]);

		const prompt = await run.raised("select");
		expect(prompt).toMatchObject({ method: "select", toolCallId: "call-0" });
		if (prompt.method !== "select") throw new Error("the permission prompt is a select");
		expect(prompt.title).toContain("Permission required: bash");
		expect(run.respond({ type: "extension_ui_response", id: prompt.id, value: "Allow once" })).toBe(true);

		const [result] = await run.results;
		expect(result).toContain("hand-ran");
	});

	it("SC-C5(iv): a denial answered where the session runs blocks the call on the hand", async () => {
		const run = await split([["bash", { command: "echo hand-ran" }]], { serves: true }, [
			"--permission-preset",
			"ask",
		]);

		const prompt = await run.raised("select");
		expect(run.respond({ type: "extension_ui_response", id: prompt.id, value: "Deny" })).toBe(true);

		const [result] = await run.results;
		expect(result).not.toContain("hand-ran");
	});
});
