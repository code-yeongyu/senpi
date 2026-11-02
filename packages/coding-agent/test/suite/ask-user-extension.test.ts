import { afterEach, describe, expect, it, vi } from "vitest";
import { mapSdkToolNameToPi, resolveSdkTools } from "../../src/core/extensions/builtin/anthropic-subscription/tools.ts";
import askUserExtension from "../../src/core/extensions/builtin/ask-user/index.ts";
import { getPendingQuestions } from "../../src/core/extensions/builtin/ask-user/registry.ts";
import { askUserRenderers } from "../../src/core/extensions/builtin/ask-user/render.ts";
import { WAIT_FLAG_STEER_TEXT } from "../../src/core/extensions/builtin/ask-user/schema.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
	QuestionResponse,
} from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

const args = {
	questions: [{ header: "Library", question: "Which library?", multiSelect: false }],
	waitForAnswer: true,
};
const answer: QuestionResponse = { status: "answered", answers: { q1: { selected: ["A"] } }, unanswered: [] };
const harnesses: Harness[] = [];
async function setup(enabled = true, flag = false) {
	const wakeEvents: unknown[] = [];
	const deliveries: unknown[] = [];
	let api: ExtensionAPI | undefined;
	const h = await createHarness({
		extensionFactories: [
			{
				factory: (pi) => {
					api = pi;
					pi.events.on("wake_source_state", (event) => wakeEvents.push(event));
					askUserExtension(pi);
				},
			},
		],
		settings: { askUser: { enabled } },
		extensionFlagValues: new Map([["no-ask-user", flag]]),
	});
	harnesses.push(h);
	await h.session.bindExtensions({});
	if (!api) throw new Error("extension factory never ran");
	// Async delivery belongs to the extension; record it instead of starting a turn.
	api.sendUserMessage = (content) => {
		deliveries.push(content);
	};
	const runner = h.getExtensionRunner();
	const ctx: ExtensionContext = {
		...runner.createContext(),
		mode: "tui",
		hasUI: true,
		ui: { ...runner.createContext().ui, question: vi.fn(async () => answer) },
	};
	const tool = runner.getAllRegisteredTools().find((t) => t.definition.name === "ask_user_question")?.definition;
	return { h, runner, ctx, tool, wakeEvents, deliveries };
}
function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("missing tool");
	return value;
}
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
	vi.useRealTimers();
});
describe("ask-user builtin", () => {
	it("activates exactly one family and swaps on model_select", async () => {
		const { h, runner } = await setup();
		expect(h.session.getActiveToolNames()).toContain("ask_user_question");
		await runner.emitModelSelect({
			type: "model_select",
			model: { ...h.getModel(), id: "gpt-5.6", api: "openai-responses" },
			previousModel: h.getModel(),
			source: "set",
			systemPrompt: "",
			systemPromptOptions: { cwd: h.tempDir },
		});
		expect(h.session.getActiveToolNames()).toContain("request_user_input");
		expect(h.session.getActiveToolNames()).not.toContain("ask_user_question");
		await runner.emitModelSelect({
			type: "model_select",
			model: h.getModel(),
			previousModel: undefined,
			source: "set",
			systemPrompt: "",
			systemPromptOptions: { cwd: h.tempDir },
		});
		expect(h.session.getActiveToolNames()).toContain("ask_user_question");
		expect(h.session.getActiveToolNames()).not.toContain("request_user_input");
	});
	it.each([
		[false, false],
		[true, true],
	])(
		"does not register or activate when disabled, yet still renders its cards (%s, flag %s)",
		async (enabled, flag) => {
			const { h, runner, tool, ctx } = await setup(enabled, flag);
			expect(runner.getFlags().get("no-ask-user")).toMatchObject({ type: "boolean", default: false });
			expect(
				runner
					.getAllRegisteredTools()
					.filter((t) => ["ask_user_question", "request_user_input"].includes(t.definition.name)),
			).toEqual([]);
			expect(
				h.session.getActiveToolNames().filter((name) => ["ask_user_question", "request_user_input"].includes(name)),
			).toEqual([]);
			for (const name of ["ask_user_question", "request_user_input"])
				expect(askUserRenderers(name)?.renderCall).toBeTypeOf("function");
			expect(tool).toBeUndefined();
			expect(ctx.ui.question).not.toHaveBeenCalled();
		},
	);
	it("returns blocking answers through the formatter", async () => {
		const { tool, ctx, deliveries } = await setup();
		const result = await required(tool).execute("blocking", args, undefined, undefined, ctx as ExtensionToolContext);
		expect(result.content).toEqual([{ type: "text", text: "Library: A" }]);
		expect(result.details).toMatchObject({ status: "answered", answers: { "Which library?": "A" } });
		// A blocking answer travels as the tool result only.
		expect(deliveries).toEqual([]);
	});
	it("returns async acceptance before answer and tracks wake source until settlement", async () => {
		const { tool, ctx, wakeEvents, deliveries } = await setup();
		vi.useFakeTimers({ toFake: ["Date"], now: 0 });
		const completion = Promise.withResolvers<QuestionResponse>();
		const resolved = Promise.withResolvers<void>();
		ctx.ui.question = vi.fn(() => completion.promise);
		const result = await required(tool).execute(
			"async",
			{ ...args, waitForAnswer: false },
			undefined,
			undefined,
			ctx as ExtensionToolContext,
		);
		expect(result.details).toMatchObject({ accepted: true, requestId: "async", status: "pending" });
		expect(ctx.ui.question).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ deliver: "user-message" }),
		);
		const pending = required(getPendingQuestions(ctx.sessionManager.getSessionId())[0]);
		pending.completion.then(() => resolved.resolve());
		completion.resolve(answer);
		await resolved.promise;
		expect(getPendingQuestions(ctx.sessionManager.getSessionId())).toEqual([]);
		expect(wakeEvents).toEqual([
			{
				source: "ask-user",
				activeCount: 1,
				items: [{ id: "async", description: "Library", deadlineAtMs: 1_800_000 }],
			},
			{ source: "ask-user", activeCount: 0, items: [] },
		]);
		expect(deliveries).toEqual(["[Answer to question async]\nLibrary: A"]);
	});
	it.each(["tui", "print", "json"])("deactivates unavailable %s calls", async (mode) => {
		const { h, tool, ctx } = await setup();
		if (mode !== "tui" && mode !== "print" && mode !== "json" && mode !== "rpc") throw new Error("mode");
		ctx.mode = mode;
		ctx.hasUI = false;
		const question = ctx.ui.question;
		if (mode === "tui") ctx.ui.question = undefined;
		expect(
			(await required(tool).execute("none", args, undefined, undefined, ctx as ExtensionToolContext)).details,
		).toMatchObject({
			status: "unavailable",
		});
		expect(h.session.getActiveToolNames()).not.toContain("ask_user_question");
		expect(question).not.toHaveBeenCalled();
	});
	it("calls a supplied question bridge even when hasUI is false", async () => {
		const { tool, ctx } = await setup();
		ctx.hasUI = false;
		expect(
			(await required(tool).execute("bridge", args, undefined, undefined, ctx as ExtensionToolContext)).details,
		).toMatchObject({
			status: "answered",
		});
	});
	it("delegates RPC capability decisions and preserves unavailable responses", async () => {
		const { tool, ctx } = await setup();
		ctx.mode = "rpc";
		ctx.hasUI = false;
		ctx.ui.question = vi.fn(
			async (): Promise<QuestionResponse> => ({ status: "unavailable", answers: {}, unanswered: ["q1"] }),
		);
		expect(
			(await required(tool).execute("rpc", args, undefined, undefined, ctx as ExtensionToolContext)).details,
		).toMatchObject({
			status: "unavailable",
		});
		expect(ctx.ui.question).toHaveBeenCalledOnce();
	});
	it("round trips the SDK custom-tool name through host blocking execution", async () => {
		const { tool, ctx } = await setup();
		const definition = required(tool);
		const mapped = resolveSdkTools({ messages: [], tools: [definition] });
		const wireName = mapped.customToolNameToSdk.get(definition.name);
		expect(wireName).toBe("mcp__custom-tools__ask_user_question");
		expect(mapSdkToolNameToPi(required(wireName), mapped.customToolNameToPi)).toBe(definition.name);
		expect(
			(await definition.execute("sdk", args, undefined, undefined, ctx as ExtensionToolContext)).details,
		).toMatchObject({
			status: "answered",
		});
	});
	it("rejects a missing wait flag before opening UI", async () => {
		const { tool, ctx } = await setup();
		const result = await required(tool).execute(
			"missing",
			{ questions: args.questions },
			undefined,
			undefined,
			ctx as ExtensionToolContext,
		);
		expect(result.content).toEqual([{ type: "text", text: WAIT_FLAG_STEER_TEXT }]);
		expect(ctx.ui.question).not.toHaveBeenCalled();
	});
	it("aborts a pending UI and cleans the registry", async () => {
		const { tool, ctx } = await setup();
		const controller = new AbortController();
		ctx.ui.question = vi.fn(() => new Promise<QuestionResponse>(() => {}));
		const execution = required(tool).execute(
			"abort",
			args,
			controller.signal,
			undefined,
			ctx as ExtensionToolContext,
		);
		controller.abort();
		expect((await execution).details).toMatchObject({ status: "cancelled" });
		expect(getPendingQuestions(ctx.sessionManager.getSessionId())).toEqual([]);
	});
	it("preserves progress drafts and extends idle time without exceeding the hard cap", async () => {
		vi.useFakeTimers();
		const { tool, ctx } = await setup();
		let progress: Parameters<NonNullable<ExtensionContext["ui"]["question"]>>[1];
		ctx.ui.question = vi.fn((_request, opts) => {
			progress = opts;
			return new Promise<QuestionResponse>(() => {});
		});
		const execution = required(tool).execute("progress", args, undefined, undefined, ctx as ExtensionToolContext);
		for (let n = 0; n < 4; n++) {
			await vi.advanceTimersByTimeAsync(29 * 60_000);
			required(progress).onProgress?.({ answers: { q1: { selected: ["A"] } } });
			required(progress).onProgress?.({ comment: "draft" });
		}
		await vi.advanceTimersByTimeAsync(4 * 60_000);
		expect((await execution).details).toMatchObject({
			status: "timed_out",
			answers: { "Which library?": "A" },
			freeText: "draft",
		});
	});
	it("times out deterministically, guards this turn, and resets on agent_end", async () => {
		vi.useFakeTimers();
		const { tool, ctx, runner } = await setup();
		ctx.ui.question = vi.fn(() => new Promise<QuestionResponse>(() => {}));
		const first = required(tool).execute("timeout", args, undefined, undefined, ctx as ExtensionToolContext);
		await vi.advanceTimersByTimeAsync(1_800_000);
		expect((await first).details).toMatchObject({ status: "timed_out" });
		expect(
			(await required(tool).execute("again", args, undefined, undefined, ctx as ExtensionToolContext)).details,
		).toMatchObject({
			status: "unavailable",
		});
		expect(ctx.ui.question).toHaveBeenCalledTimes(1);
		await runner.emit({ type: "agent_end", messages: [] });
		ctx.ui.question = vi.fn(async () => answer);
		expect(
			(await required(tool).execute("next", args, undefined, undefined, ctx as ExtensionToolContext)).details,
		).toMatchObject({
			status: "answered",
		});
	});

	it("refuses a required question's gated action through the real tool on timeout and on the re-ask guard", async () => {
		// given a required question the user never answers
		vi.useFakeTimers();
		const { tool, ctx } = await setup();
		ctx.ui.question = vi.fn(() => new Promise<QuestionResponse>(() => {}));
		const gated = { ...args, required: true };

		// when it times out, and a second required question is asked in the same turn
		const first = required(tool).execute("gate", gated, undefined, undefined, ctx as ExtensionToolContext);
		await vi.advanceTimersByTimeAsync(1_800_000);
		const timedOut = await first;
		const reask = await required(tool).execute(
			"gate-again",
			gated,
			undefined,
			undefined,
			ctx as ExtensionToolContext,
		);

		// then neither tool result invites the model to proceed
		for (const outcome of [timedOut, reask]) {
			const text = outcome.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
			expect(text).toContain("do not take the action it gates");
			expect(text).not.toMatch(/best judgment|continue without asking/i);
		}
	});

	it("keeps a UI failure's reason and refuses the gated action for a required question", async () => {
		// given a required question whose UI fails while it is open
		const { tool, ctx } = await setup();
		ctx.ui.question = vi.fn(async (_request, options) => {
			options?.onProgress?.({ answers: { q1: { selected: [], text: "only on staging" } } });
			throw new Error("boom");
		});

		// when the blocking call settles
		const outcome = await required(tool).execute(
			"gate-ui",
			{ ...args, required: true },
			undefined,
			undefined,
			ctx as ExtensionToolContext,
		);

		// then the reason is kept and the model is told not to take the gated action
		const text = outcome.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		expect(text).toContain("Question UI failed: boom");
		expect(text).toContain("do not take the action it gates");
		const userWords = (outcome.details as { userWords?: Array<{ label: string }> }).userWords ?? [];
		expect(userWords).toHaveLength(1);
		for (const word of userWords) expect(text).toContain(word.label);
		expect(text).toContain("not an answer");
		expect(text).not.toContain("The user dismissed the question.");
	});

	it("sends the user's typed draft along with a dismissed required question", async () => {
		// given a required question the user typed a draft into and then dismissed
		const { tool, ctx } = await setup();
		ctx.ui.question = vi.fn(async () => ({
			status: "cancelled" as const,
			answers: { q1: { selected: [], text: "only after tests pass" } },
			unanswered: [],
		}));

		// when the blocking call settles
		const outcome = await required(tool).execute(
			"gate-draft",
			{ ...args, required: true },
			undefined,
			undefined,
			ctx as ExtensionToolContext,
		);

		// then the refusal points at the draft and the draft travels in the result details
		const text = outcome.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		expect(text).toContain("do not take the action it gates");
		expect(text).not.toContain("only after tests pass");
		const userWords = (outcome.details as { userWords?: Array<{ text: string }> }).userWords ?? [];
		expect(userWords.map((word) => word.text)).toContain("only after tests pass");
	});
});
