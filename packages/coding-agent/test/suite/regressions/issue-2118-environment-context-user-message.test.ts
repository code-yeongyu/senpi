import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Context, fauxAssistantMessage, type Model, normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convertMessages, getCompat } from "../../../../ai/src/api/openai-completions.ts";
import { createEnvironmentContextMessage, formatEnvironmentContext } from "../../../src/core/environment-context.ts";
import { convertToLlm } from "../../../src/core/messages.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#2118: the environment context is the leading content block of the user
// message it precedes, so Chat Completions requests never carry two consecutive
// user messages (alternation-enforcing chat templates reject that).

const DAY_ONE = new Date("2026-09-24T12:00:00.000Z");
const DAY_TWO = new Date("2026-09-25T12:00:00.000Z");

const CHAT_COMPLETIONS_MODEL: Model<"openai-completions"> = {
	id: "alternation-template",
	name: "Alternation template",
	api: "openai-completions",
	provider: "alternation-template",
	baseUrl: "http://127.0.0.1:1/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_000,
	maxTokens: 1_000,
};

function chatPayload(context: Context | undefined): Array<Record<string, unknown>> {
	if (!context) throw new Error("no captured request");
	const payload = convertMessages(
		CHAT_COMPLETIONS_MODEL,
		normalizeContext(context),
		getCompat(CHAT_COMPLETIONS_MODEL),
	);
	return JSON.parse(JSON.stringify(payload)) as Array<Record<string, unknown>>;
}

function environmentText(harness: Harness, day: Date): string {
	return formatEnvironmentContext({
		cwd: harness.tempDir.replace(/\\/g, "/"),
		currentDate: day.toISOString().slice(0, 10),
	});
}

function textBlocks(...texts: string[]): Array<{ type: "text"; text: string }> {
	return texts.map((text) => ({ type: "text", text }));
}

describe("senpi#2118: environment context folds into the next user message", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		vi.useRealTimers();
	});

	async function start(options?: Parameters<typeof createHarness>[0]): Promise<Harness> {
		vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
		vi.setSystemTime(DAY_ONE);
		const harness = await createHarness({ environmentContext: true, ...options });
		harnesses.push(harness);
		return harness;
	}

	it("sends the first turn as one user message whose first block is the environment context", async () => {
		const harness = await start();
		harness.setResponses([fauxAssistantMessage("first")]);
		await harness.session.prompt("hi");

		const chat = chatPayload(harness.faux.getCallLog()[0]?.context);
		expect(chat.map((message) => message.role)).toEqual(["system", "user"]);
		expect(chat[1]?.content).toEqual(textBlocks(environmentText(harness, DAY_ONE), "hi"));
	});

	it("appends a rollover environment block only to the next user message", async () => {
		const harness = await start();
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await harness.session.prompt("hi");
		vi.setSystemTime(DAY_TWO);
		await harness.session.prompt("tomorrow");

		const [first, second] = harness.faux.getCallLog().map((call) => chatPayload(call.context));
		expect(second?.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
		expect(second?.slice(0, first?.length)).toEqual(first);
		expect(second?.[3]?.content).toEqual(textBlocks(environmentText(harness, DAY_TWO), "tomorrow"));
	});

	it("rebuilds identical request bytes from the persisted session on resume", async () => {
		const harness = await start({ persistSession: true });
		harness.setResponses([fauxAssistantMessage("first")]);
		await harness.session.prompt("hi");
		const sentContext = harness.faux.getCallLog()[0]?.context;
		const sessionFile = harness.sessionManager.getSessionFile();
		if (!sessionFile || !sentContext) throw new Error("persisted harness has no session file or request");

		const resumed = convertToLlm(SessionManager.open(sessionFile).buildSessionContext().messages);
		const sent = JSON.stringify(chatPayload(sentContext));
		const replayed = chatPayload({ systemPrompt: sentContext.systemPrompt, messages: resumed });
		expect(JSON.stringify(replayed.slice(0, 2))).toBe(sent);
	});

	it("keeps an environment context that no user message follows as a standalone user message", () => {
		const environment = createEnvironmentContextMessage({ cwd: "/work", currentDate: "2026-09-24" }, 1);
		const assistant = fauxAssistantMessage("answer");
		const text = formatEnvironmentContext({ cwd: "/work", currentDate: "2026-09-24" });

		const trailing = convertToLlm([{ role: "user", content: "hi", timestamp: 0 }, assistant, environment]);
		expect(trailing.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
		expect(trailing[2]?.content).toEqual(textBlocks(text));

		const beforeAssistant = convertToLlm([environment, assistant]);
		expect(beforeAssistant.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("folds into a triggered custom message the same way as into a prompt", () => {
		const environment = createEnvironmentContextMessage({ cwd: "/work", currentDate: "2026-09-24" }, 1);
		const custom: AgentMessage = {
			role: "custom",
			customType: "extension-note",
			content: "note",
			display: true,
			timestamp: 2,
		};

		const converted = convertToLlm([environment, custom]);
		expect(converted).toHaveLength(1);
		expect(converted[0]?.content).toEqual(
			textBlocks(formatEnvironmentContext({ cwd: "/work", currentDate: "2026-09-24" }), "note"),
		);
	});
});
