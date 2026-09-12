import { describe, expect, it } from "vitest";
import {
	buildCursorCliContextRecap,
	CURSOR_CLI_CONTEXT_RECAP_BEGIN,
	CURSOR_CLI_CONTEXT_RECAP_END,
	CURSOR_CLI_CONTEXT_RECAP_MAX_BYTES,
	type CursorCliRecapExchange,
	type CursorCliSessionAttempt,
	type CursorCliSessionRestartNotice,
	CursorCliSessionRouter,
	type CursorCliSessionTurnContext,
	type CursorCliTurnPlan,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/session-router.ts";
import {
	CursorCliAbortError,
	CursorCliPromptTooLargeError,
	MAX_CURSOR_CLI_PROMPT_BYTES,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/transport.ts";

type TestEvent =
	| { type: "system"; subtype: "init"; session_id: string; model: string }
	| { type: "assistant"; message: { content: Array<{ type: "text"; text: string }> } };

type OutputEvent = TestEvent | CursorCliSessionRestartNotice;
type ScriptStep = TestEvent[] | { readonly failure: unknown };

const fixedNow = 1_770_000_000_000;
const alphaContext: CursorCliSessionTurnContext = { senpiSessionId: "senpi-session-1", accountName: "alpha" };

function makeRouter(): CursorCliSessionRouter {
	return new CursorCliSessionRouter({ now: () => fixedNow });
}

function initEvent(sessionId: string, model: string): TestEvent {
	return { type: "system", subtype: "init", session_id: sessionId, model };
}

function assistantEvent(text: string): TestEvent {
	return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

function exchanges(count: number, marker: string, bytesPerExchange = 64): CursorCliRecapExchange[] {
	return Array.from({ length: count }, (_, index) => ({
		role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
		text: `${marker}-${index}: ${"x".repeat(bytesPerExchange)}`,
	}));
}

function scriptedRunner(script: readonly ScriptStep[]) {
	const attempts: CursorCliSessionAttempt[] = [];
	const runAttempt = (attempt: CursorCliSessionAttempt): AsyncIterable<TestEvent> => {
		attempts.push(attempt);
		const step = script[attempts.length - 1];
		if (step === undefined) throw new Error(`unexpected attempt #${attempts.length}`);
		return (async function* () {
			if (!Array.isArray(step)) throw step.failure;
			for (const event of step) yield event;
		})();
	};
	return { attempts, runAttempt };
}

async function collect(stream: AsyncIterable<OutputEvent>): Promise<OutputEvent[]> {
	const events: OutputEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

async function primeChat(router: CursorCliSessionRouter, chatId: string, model: string): Promise<void> {
	const { runAttempt } = scriptedRunner([[initEvent(chatId, model), assistantEvent("seeded")]]);
	await collect(router.runTurn({ ...alphaContext, runAttempt }, { prompt: "seed turn", model }));
}

function restartNotice(events: readonly OutputEvent[]): CursorCliSessionRestartNotice | undefined {
	return events.find((event): event is CursorCliSessionRestartNotice => event.type === "cursor_chat_restarted");
}

describe("Cursor CLI OAuth session router", () => {
	it("spawns fresh without a record and captures the chat id from system/init", async () => {
		const router = makeRouter();
		const { attempts, runAttempt } = scriptedRunner([[initEvent("chat-1", "model-a"), assistantEvent("hello")]]);

		const events = await collect(
			router.runTurn({ ...alphaContext, runAttempt }, { prompt: "first turn", model: "model-a" }),
		);

		expect(attempts).toEqual([{ prompt: "first turn", resumeChatId: undefined }]);
		expect(events).toEqual([initEvent("chat-1", "model-a"), assistantEvent("hello")]);
		expect(router.getRecord(alphaContext.senpiSessionId)).toEqual({
			accountName: "alpha",
			chatId: "chat-1",
			lastModel: "model-a",
			lastUsedAt: fixedNow,
		});
	});

	it("resumes the recorded chat on same-model turns without a recap", async () => {
		const router = makeRouter();
		await primeChat(router, "chat-1", "model-a");
		const { attempts, runAttempt } = scriptedRunner([[initEvent("chat-1", "model-a"), assistantEvent("again")]]);

		await collect(
			router.runTurn(
				{ ...alphaContext, runAttempt },
				{ prompt: "second turn", model: "model-a", recentExchanges: exchanges(3, "hist") },
			),
		);

		expect(attempts).toEqual([{ prompt: "second turn", resumeChatId: "chat-1" }]);
		expect(attempts[0]?.prompt.includes(CURSOR_CLI_CONTEXT_RECAP_BEGIN)).toBe(false);
	});

	it("prepends exactly one recap on the first post-switch turn and none on the next", async () => {
		const router = makeRouter();
		await primeChat(router, "chat-1", "model-a");
		const recent = exchanges(6, "hist", 200);

		const switchTurn = scriptedRunner([[initEvent("chat-1", "model-b"), assistantEvent("switched")]]);
		await collect(
			router.runTurn(
				{ ...alphaContext, runAttempt: switchTurn.runAttempt },
				{ prompt: "switch turn", model: "model-b", recentExchanges: recent },
			),
		);
		const switchPrompt = switchTurn.attempts[0]?.prompt ?? "";
		expect(switchTurn.attempts[0]?.resumeChatId).toBe("chat-1");
		expect(switchPrompt.startsWith(CURSOR_CLI_CONTEXT_RECAP_BEGIN)).toBe(true);
		expect(occurrences(switchPrompt, CURSOR_CLI_CONTEXT_RECAP_BEGIN)).toBe(1);
		expect(occurrences(switchPrompt, CURSOR_CLI_CONTEXT_RECAP_END)).toBe(1);
		expect(switchPrompt.endsWith("switch turn")).toBe(true);
		expect(switchPrompt).toContain("hist-5");

		const nextTurn = scriptedRunner([[initEvent("chat-1", "model-b"), assistantEvent("settled")]]);
		await collect(
			router.runTurn(
				{ ...alphaContext, runAttempt: nextTurn.runAttempt },
				{ prompt: "next turn", model: "model-b", recentExchanges: recent },
			),
		);
		expect(nextTurn.attempts[0]?.prompt).toBe("next turn");
		expect(nextTurn.attempts[0]?.resumeChatId).toBe("chat-1");
		expect(router.getRecord(alphaContext.senpiSessionId)).toMatchObject({ chatId: "chat-1", lastModel: "model-b" });

		const switchBack = scriptedRunner([[initEvent("chat-1", "model-a"), assistantEvent("back")]]);
		await collect(
			router.runTurn(
				{ ...alphaContext, runAttempt: switchBack.runAttempt },
				{ prompt: "back turn", model: "model-a", recentExchanges: recent },
			),
		);
		const backPrompt = switchBack.attempts[0]?.prompt ?? "";
		expect(occurrences(backPrompt, CURSOR_CLI_CONTEXT_RECAP_BEGIN)).toBe(1);
	});

	it("falls back to a fresh chat on resume failure, records the new chat id, and surfaces a notice", async () => {
		const router = makeRouter();
		await primeChat(router, "chat-2", "model-a");
		const { attempts, runAttempt } = scriptedRunner([
			{ failure: { stderr: "Error: session chat-2 not found" } },
			[initEvent("chat-9", "model-a"), assistantEvent("fresh answer")],
		]);

		const events = await collect(
			router.runTurn(
				{ ...alphaContext, runAttempt },
				{ prompt: "second turn", model: "model-a", recentExchanges: exchanges(2, "hist") },
			),
		);

		expect(attempts).toHaveLength(2);
		expect(attempts[0]?.resumeChatId).toBe("chat-2");
		expect(attempts[0]?.prompt).toBe("second turn");
		expect(attempts[1]?.resumeChatId).toBeUndefined();
		expect(attempts[1]?.prompt.startsWith(CURSOR_CLI_CONTEXT_RECAP_BEGIN)).toBe(true);
		expect(attempts[1]?.prompt.endsWith("second turn")).toBe(true);

		const notice = restartNotice(events);
		expect(notice).toMatchObject({
			type: "cursor_chat_restarted",
			previousChatId: "chat-2",
			reason: "resume_failed",
		});
		expect(notice?.message).toContain("fresh chat");
		expect(events[0]).toBe(notice);
		expect(router.getRecord(alphaContext.senpiSessionId)).toEqual({
			accountName: "alpha",
			chatId: "chat-9",
			lastModel: "model-a",
			lastUsedAt: fixedNow,
		});
	});

	it("bounds the fresh-chat fallback to one retry instead of looping", async () => {
		const router = makeRouter();
		await primeChat(router, "chat-2", "model-a");
		const { attempts, runAttempt } = scriptedRunner([
			{ failure: { stderr: "Error: session chat-2 not found" } },
			{ failure: { stderr: "Error: session chat-2 not found" } },
		]);

		await expect(
			collect(router.runTurn({ ...alphaContext, runAttempt }, { prompt: "doomed", model: "model-a" })),
		).rejects.toMatchObject({ stderr: "Error: session chat-2 not found" });
		expect(attempts).toHaveLength(2);
	});

	it("treats context_overflow as a fresh-chat restart with a notice", async () => {
		const router = makeRouter();
		await primeChat(router, "chat-3", "model-a");
		const { attempts, runAttempt } = scriptedRunner([
			{ failure: { stderr: "token limit exceeded" } },
			[initEvent("chat-10", "model-a"), assistantEvent("fresh answer")],
		]);

		const events = await collect(
			router.runTurn(
				{
					...alphaContext,
					runAttempt,
					classify: () => ({ kind: "context_overflow", retryable: false }),
				},
				{ prompt: "overflow turn", model: "model-a" },
			),
		);

		expect(attempts[0]?.resumeChatId).toBe("chat-3");
		expect(attempts[1]?.resumeChatId).toBeUndefined();
		expect(restartNotice(events)).toMatchObject({
			previousChatId: "chat-3",
			reason: "context_overflow",
		});
		expect(router.getRecord(alphaContext.senpiSessionId)).toMatchObject({ chatId: "chat-10" });
	});

	it("caps the recap at 8 KB and keeps the newest exchanges", () => {
		const recap = buildCursorCliContextRecap("model-b", exchanges(40, "hist", 1024));

		expect(recap).toBeDefined();
		expect(Buffer.byteLength(recap ?? "", "utf8")).toBeLessThanOrEqual(CURSOR_CLI_CONTEXT_RECAP_MAX_BYTES);
		expect(recap?.startsWith(CURSOR_CLI_CONTEXT_RECAP_BEGIN)).toBe(true);
		expect(recap?.endsWith(CURSOR_CLI_CONTEXT_RECAP_END)).toBe(true);
		expect(recap).toContain("hist-39");
		expect(recap).not.toContain("hist-0");
	});

	it("truncates a single exchange that alone exceeds the recap budget", () => {
		const recap = buildCursorCliContextRecap("model-b", [{ role: "user", text: "z".repeat(64_000) }]);

		expect(recap).toBeDefined();
		expect(Buffer.byteLength(recap ?? "", "utf8")).toBeLessThanOrEqual(CURSOR_CLI_CONTEXT_RECAP_MAX_BYTES);
		expect(recap).toContain("user: z");
		expect(recap?.endsWith(CURSOR_CLI_CONTEXT_RECAP_END)).toBe(true);
	});

	it("returns no recap when there is nothing to recap", () => {
		expect(buildCursorCliContextRecap("model-b", [])).toBeUndefined();
		expect(buildCursorCliContextRecap("model-b", [{ role: "user", text: "" }])).toBeUndefined();
		expect(buildCursorCliContextRecap("model-b", undefined)).toBeUndefined();
	});

	it("drops the recap to fit the prompt ceiling and never blocks the model switch", async () => {
		const router = makeRouter();
		await primeChat(router, "chat-1", "model-a");
		const longPrompt = "p".repeat(129_500);
		const { attempts, runAttempt } = scriptedRunner([[initEvent("chat-1", "model-b"), assistantEvent("done")]]);

		await collect(
			router.runTurn(
				{ ...alphaContext, runAttempt },
				{
					prompt: longPrompt,
					model: "model-b",
					recentExchanges: exchanges(4, "hist", 2048),
				},
			),
		);

		expect(attempts[0]?.prompt).toBe(longPrompt);
		expect(Buffer.byteLength(attempts[0]?.prompt ?? "", "utf8")).toBeLessThanOrEqual(MAX_CURSOR_CLI_PROMPT_BYTES);
		expect(attempts[0]?.resumeChatId).toBe("chat-1");
		expect(attempts[0]?.prompt.includes(CURSOR_CLI_CONTEXT_RECAP_BEGIN)).toBe(false);
	});

	it("errors on prompts that stay oversized after shrinking, before spawning", async () => {
		const router = makeRouter();
		const { attempts, runAttempt } = scriptedRunner([[initEvent("chat-1", "model-a"), assistantEvent("x")]]);

		await expect(
			collect(
				router.runTurn(
					{ ...alphaContext, runAttempt },
					{ prompt: "q".repeat(MAX_CURSOR_CLI_PROMPT_BYTES + 1), model: "model-a" },
				),
			),
		).rejects.toBeInstanceOf(CursorCliPromptTooLargeError);
		expect(attempts).toHaveLength(0);
	});

	it("updates the record when a resumed turn reports a new session id", async () => {
		const router = makeRouter();
		await primeChat(router, "chat-1", "model-a");
		const { runAttempt } = scriptedRunner([[initEvent("chat-77", "model-a"), assistantEvent("ok")]]);

		await collect(router.runTurn({ ...alphaContext, runAttempt }, { prompt: "again", model: "model-a" }));

		expect(router.getRecord(alphaContext.senpiSessionId)).toMatchObject({ chatId: "chat-77", lastModel: "model-a" });
	});

	it("starts a fresh chat when the bound account differs from the turn's account", async () => {
		const router = makeRouter();
		await primeChat(router, "chat-1", "model-a");
		const { attempts, runAttempt } = scriptedRunner([[initEvent("chat-8", "model-a"), assistantEvent("bravo")]]);

		await collect(
			router.runTurn(
				{ senpiSessionId: alphaContext.senpiSessionId, accountName: "bravo", runAttempt },
				{ prompt: "new account", model: "model-a" },
			),
		);

		expect(attempts[0]?.resumeChatId).toBeUndefined();
		expect(router.getRecord(alphaContext.senpiSessionId)).toEqual({
			accountName: "bravo",
			chatId: "chat-8",
			lastModel: "model-a",
			lastUsedAt: fixedNow,
		});
	});

	it("never resumes when resumeMode is off", async () => {
		const router = makeRouter();
		const first = scriptedRunner([[initEvent("chat-1", "model-a"), assistantEvent("one")]]);
		await collect(
			router.runTurn(
				{ ...alphaContext, runAttempt: first.runAttempt, resumeMode: "off" },
				{ prompt: "one", model: "model-a" },
			),
		);
		const second = scriptedRunner([[initEvent("chat-2", "model-b"), assistantEvent("two")]]);
		await collect(
			router.runTurn(
				{ ...alphaContext, runAttempt: second.runAttempt, resumeMode: "off" },
				{ prompt: "two", model: "model-b", recentExchanges: exchanges(2, "hist") },
			),
		);

		expect(second.attempts[0]?.resumeChatId).toBeUndefined();
		expect(second.attempts[0]?.prompt).toBe("two");
	});

	it("omits the recap on model switches when contextRecapOnModelSwitch is false", async () => {
		const router = makeRouter();
		await primeChat(router, "chat-1", "model-a");
		const { attempts, runAttempt } = scriptedRunner([[initEvent("chat-1", "model-b"), assistantEvent("ok")]]);

		await collect(
			router.runTurn(
				{ ...alphaContext, runAttempt, contextRecapOnModelSwitch: false },
				{ prompt: "switch", model: "model-b", recentExchanges: exchanges(2, "hist") },
			),
		);

		expect(attempts[0]?.resumeChatId).toBe("chat-1");
		expect(attempts[0]?.prompt).toBe("switch");
	});

	it("does not fall back on abort and leaves the record untouched", async () => {
		const router = makeRouter();
		await primeChat(router, "chat-1", "model-a");
		const before = router.getRecord(alphaContext.senpiSessionId);
		const { attempts, runAttempt } = scriptedRunner([{ failure: new CursorCliAbortError() }]);

		await expect(
			collect(router.runTurn({ ...alphaContext, runAttempt }, { prompt: "cancelled", model: "model-a" })),
		).rejects.toBeInstanceOf(CursorCliAbortError);
		expect(attempts).toHaveLength(1);
		expect(router.getRecord(alphaContext.senpiSessionId)).toEqual(before);
	});

	it("keeps the turn decision idempotent and records nothing before an init event", async () => {
		const router = makeRouter();
		await primeChat(router, "chat-1", "model-a");
		const turnInput = {
			prompt: "planned",
			model: "model-b",
			recentExchanges: exchanges(2, "hist"),
		};

		const first: CursorCliTurnPlan = router.planTurn(alphaContext, turnInput);
		const second: CursorCliTurnPlan = router.planTurn(alphaContext, turnInput);
		expect(first).toStrictEqual(second);
		expect(first.modelSwitch).toBe(true);
		expect(first.resumeChatId).toBe("chat-1");

		const before = router.getRecord(alphaContext.senpiSessionId);
		const { runAttempt } = scriptedRunner([{ failure: { stderr: "fetch failed: socket hang up" } }]);
		await expect(
			collect(router.runTurn({ ...alphaContext, runAttempt }, { prompt: "fails early", model: "model-b" })),
		).rejects.toMatchObject({ stderr: "fetch failed: socket hang up" });
		expect(router.getRecord(alphaContext.senpiSessionId)).toEqual(before);
	});

	it("never persists transcript text beyond the recap window", async () => {
		const router = makeRouter();
		await primeChat(router, "chat-1", "model-a");
		const sentinel = "TRANSCRIPT-SENTINEL-9f2c";
		const { attempts, runAttempt } = scriptedRunner([[initEvent("chat-1", "model-b"), assistantEvent("ok")]]);

		await collect(
			router.runTurn(
				{ ...alphaContext, runAttempt },
				{ prompt: "switch", model: "model-b", recentExchanges: [{ role: "user", text: sentinel }] },
			),
		);

		expect(attempts[0]?.prompt).toContain(sentinel);
		expect(JSON.stringify(router.getRecord(alphaContext.senpiSessionId))).not.toContain(sentinel);
	});
});
