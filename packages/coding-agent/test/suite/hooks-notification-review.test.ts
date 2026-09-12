import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../../src/core/event-bus.ts";
import { ASK_USER_SETTLED_EVENT, emitAskUserNotification } from "../../src/core/extensions/builtin/ask-user/notify.ts";
import type { QuestionResponse } from "../../src/core/extensions/builtin/ask-user/schema.ts";
import * as commandRunner from "../../src/core/extensions/builtin/hooks/command-runner.ts";
import {
	buildNotificationHookInput,
	dispatchNotificationHookEvent,
	notificationResultDetails,
	recordLifecycleHookResult,
} from "../../src/core/extensions/builtin/hooks/lifecycle-adapter.ts";
import { parseHookConfig } from "../../src/core/extensions/builtin/hooks/schema.ts";
import { createHookTrustEntry, hookTrustId } from "../../src/core/extensions/builtin/hooks/trust.ts";
import { FileHookStateStorage } from "../../src/core/extensions/builtin/hooks/trust-storage.ts";
import type {
	ExecutableHookHandler,
	HookInputWire,
	HookTrustState,
} from "../../src/core/extensions/builtin/hooks/types.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const roots: string[] = [];
const harnesses: Harness[] = [];
const args = {
	questions: [{ header: "Library", question: "Which library?", multiSelect: false }],
	waitForAnswer: true,
};
const timeout: QuestionResponse = {
	status: "timed_out",
	answers: {},
	unanswered: ["q1"],
	autoResolvedAfterMs: 1800000,
};
const answer: QuestionResponse = { status: "answered", answers: { q1: { selected: ["A"] } }, unanswered: [] };
const cancelled: QuestionResponse = { status: "cancelled", answers: {}, unanswered: ["q1"] };
const input: HookInputWire = { event: "Notification", cwd: tmpdir(), kind: "ask-user-timeout", message: "fixture" };
function root() {
	const value = mkdtempSync(join(tmpdir(), "pr1630-review-"));
	roots.push(value);
	return value;
}
function trusted(handlers: readonly ExecutableHookHandler[]): HookTrustState {
	return {
		version: 1,
		hooks: Object.fromEntries(handlers.map((handler) => [hookTrustId(handler), createHookTrustEntry(handler)])),
	};
}
function handlersFor(command: string, matcher?: string) {
	return parseHookConfig(
		{
			hooks: {
				Notification: [{ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: "command", command }] }],
			},
		},
		{ scope: "global", sourcePath: "/fixture/hooks.json", displayOrder: 0, discoveredAt: "pre-session" },
	).executableHandlers;
}
function scriptCommand(dir: string, output: unknown) {
	const path = join(dir, "hook.mjs");
	writeFileSync(
		path,
		`process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(JSON.stringify(output))}));`,
	);
	return `${JSON.stringify(process.execPath)} ${JSON.stringify(path)}`;
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("notification signal was not emitted")), 5000);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture(activation: "active" | "disabled" | "excluded" = "active") {
	const dir = root();
	const agentDir = join(dir, "agent");
	mkdirSync(agentDir);
	const stdinPath = join(dir, "stdin.jsonl");
	const scriptPath = join(dir, "record.mjs");
	writeFileSync(
		scriptPath,
		`import { appendFileSync } from 'node:fs'; let data = ''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => { appendFileSync(${JSON.stringify(stdinPath)}, JSON.stringify(JSON.parse(data)) + '\\n'); process.stdout.write(JSON.stringify({ additionalContext: JSON.parse(data).request_id })); });`,
	);
	const config = {
		hooks: {
			Notification: [
				{
					matcher: "ask-user-timeout",
					hooks: [
						{ type: "command", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}` },
					],
				},
			],
		},
	};
	const hooksPath = join(agentDir, "hooks.json");
	writeFileSync(hooksPath, JSON.stringify(config));
	const handlers = parseHookConfig(config, {
		scope: "global",
		sourcePath: hooksPath,
		displayOrder: 0,
		discoveredAt: "pre-session",
	}).executableHandlers;
	writeFileSync(join(agentDir, "hooks-state.json"), JSON.stringify(trusted(handlers)));
	const settings = {
		enabledBuiltinExtensions: activation === "excluded" ? ["ask-user"] : ["ask-user", "hooks"],
		disabledBuiltinExtensions: activation === "disabled" ? ["hooks"] : [],
		askUser: { enabled: true },
	};
	const notificationFinished = Promise.withResolvers<void>();
	const bus = createEventBus();
	const eventBus = {
		emit: bus.emit,
		on(channel: string, handler: (data: unknown) => void) {
			return bus.on(channel, async (data) => {
				await handler(data);
				if (channel === ASK_USER_SETTLED_EVENT) notificationFinished.resolve();
			});
		},
	};
	const loader = new DefaultResourceLoader({
		eventBus,
		cwd: dir,
		agentDir,
		settingsManager: SettingsManager.inMemory(settings),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	expect(
		loader
			.getExtensions()
			.extensions.map((e) => e.path)
			.includes("<builtin:hooks>"),
	).toBe(activation === "active");
	const harness = await createHarness({ resourceLoader: loader, settings });
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	const runner = harness.getExtensionRunner();
	const tool = runner.getAllRegisteredTools().find((t) => t.definition.name === "ask_user_question")?.definition;
	if (!tool) throw new Error("missing registered tool");
	const ctx: ExtensionContext = {
		...runner.createContext(),
		mode: "tui",
		hasUI: true,
		ui: { ...runner.createContext().ui, question: async () => answer },
	};
	const records: string[] = [];
	const signals = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
	harness.session.subscribe((event) => {
		if (
			event.type === "message_end" &&
			event.message.role === "custom" &&
			event.message.customType === "senpi.hook" &&
			typeof event.message.content === "string"
		) {
			records.push(event.message.content);
			signals.get(event.message.content)?.resolve();
		}
	});
	return {
		harness,
		ctx,
		tool,
		records,
		stdinPath,
		hooksPath,
		notificationFinished: notificationFinished.promise,
		completed(id: string) {
			const signal = Promise.withResolvers<void>();
			signals.set(id, signal);
			return signal.promise;
		},
		payloads(): Array<Extract<HookInputWire, { event: "Notification" }>> {
			return existsSync(stdinPath)
				? readFileSync(stdinPath, "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line))
				: [];
		},
	};
}

describe("Notification review regressions", () => {
	it.each(["ask-user-timeout", "something-else", "["])(
		"R1 dispatch ignores matcher %s but preserves trust and disabled checks",
		async (matcher) => {
			const dir = root();
			const handlers = handlersFor(scriptCommand(dir, { additionalContext: "completed" }), matcher);
			const result = await dispatchNotificationHookEvent({
				cwd: dir,
				handlers,
				input,
				trustState: trusted(handlers),
			});
			expect(result?.summaries).toHaveLength(1);
			expect(notificationResultDetails(result).contexts).toEqual(["completed"]);
			expect(result?.diagnostics).toEqual([]);
			expect(
				await dispatchNotificationHookEvent({ cwd: dir, handlers, input, trustState: { version: 1, hooks: {} } }),
			).toBeUndefined();
			const state = trusted(handlers);
			const disabled = {
				version: 1 as const,
				hooks: Object.fromEntries(
					Object.entries(state.hooks).map(([id, entry]) => [id, { ...entry, enabled: false }]),
				),
			};
			expect(
				await dispatchNotificationHookEvent({ cwd: dir, handlers, input, trustState: disabled }),
			).toBeUndefined();
		},
	);
	it.each([[], { hookEventName: "Stop", additionalContext: "rejected" }])(
		"R4 records diagnostics without rejected context for %j",
		async (hookSpecificOutput) => {
			const dir = root();
			const handlers = handlersFor(scriptCommand(dir, { hookSpecificOutput, additionalContext: "rejected" }));
			const result = await dispatchNotificationHookEvent({
				cwd: dir,
				handlers,
				input,
				trustState: trusted(handlers),
			});
			expect(result?.summaries[0]?.output.additionalContext).toBeUndefined();
			const details = notificationResultDetails(result);
			expect(details.contexts).toEqual([]);
			expect(details.diagnostics.length).toBeGreaterThan(0);
			const sendMessage = vi.fn();
			recordLifecycleHookResult({ sendMessage }, "Notification", details);
			expect(sendMessage).toHaveBeenCalledOnce();
			expect(sendMessage.mock.calls[0]?.[0].content).not.toContain("rejected");
		},
	);
	it.each(["disabled", "excluded"] as const)(
		"R2 %s hooks do not prepare or execute notifications from registered tools",
		async (activation) => {
			const f = await fixture(activation);
			const getSources = vi.spyOn(f.ctx, "getLoadedHookSources");
			expect((await f.tool.execute("disabled", args, undefined, undefined, f.ctx)).details).toMatchObject({
				status: "answered",
			});
			expect(getSources).not.toHaveBeenCalled();
			expect(f.payloads()).toEqual([]);
			expect(f.records).toEqual([]);
		},
	);
	it.each([true, false])(
		"R6 registered tool answer waitForAnswer=%s records exactly one isolated payload",
		async (waitForAnswer) => {
			const f = await fixture();
			const done = f.completed("answer");
			const result = await f.tool.execute("answer", { ...args, waitForAnswer }, undefined, undefined, f.ctx);
			expect(result.details).toMatchObject(
				waitForAnswer ? { status: "answered" } : { status: "pending", requestId: "answer" },
			);
			await bounded(done);
			expect(f.records).toEqual(["answer"]);
			expect(f.payloads()).toEqual([
				expect.objectContaining({
					event: "Notification",
					hook_event_name: "Notification",
					notification_source: "ask-user",
					request_id: "answer",
					session_id: f.ctx.sessionManager.getSessionId(),
					status: "answered",
					kind: "ask-user-settled",
					title: "Library",
					cwd: f.ctx.cwd,
				}),
			]);
		},
	);
	it.each([true, false])(
		"R6 authoritative timeout waitForAnswer=%s wins over late UI settlement",
		async (waitForAnswer) => {
			const f = await fixture();
			const ui = Promise.withResolvers<QuestionResponse>();
			f.ctx.ui.question = vi.fn(() => ui.promise);
			const done = f.completed("timeout");
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
			const execution = f.tool.execute("timeout", { ...args, waitForAnswer }, undefined, undefined, f.ctx);
			await vi.advanceTimersByTimeAsync(1800000);
			const result = await execution;
			ui.resolve(answer);
			await ui.promise;
			vi.useRealTimers();
			expect(result.details).toMatchObject({ status: waitForAnswer ? "timed_out" : "pending" });
			await bounded(done);
			expect(f.records).toEqual(["timeout"]);
			expect(f.payloads()).toEqual([
				expect.objectContaining({ request_id: "timeout", status: "timed_out", kind: "ask-user-timeout" }),
			]);
		},
	);
	it.each([true, false])(
		"R6 cancellation waitForAnswer=%s never emits a settlement notification",
		async (waitForAnswer) => {
			const f = await fixture();
			f.ctx.ui.question = async () => cancelled;
			const getSources = vi.spyOn(f.ctx, "getLoadedHookSources");
			await f.tool.execute("cancelled", { ...args, waitForAnswer }, undefined, undefined, f.ctx);
			expect(getSources).not.toHaveBeenCalled();
			expect(f.payloads()).toEqual([]);
			expect(f.records).toEqual([]);
		},
	);
	it("R6 concurrent async requests retain their IDs and settle once", async () => {
		const f = await fixture();
		const first = Promise.withResolvers<QuestionResponse>();
		const second = Promise.withResolvers<QuestionResponse>();
		f.ctx.ui.question = (request) => (request.requestId === "first" ? first.promise : second.promise);
		const firstDone = f.completed("first");
		const secondDone = f.completed("second");
		await f.tool.execute("first", { ...args, waitForAnswer: false }, undefined, undefined, f.ctx);
		await f.tool.execute("second", { ...args, waitForAnswer: false }, undefined, undefined, f.ctx);
		second.resolve(answer);
		await bounded(secondDone);
		first.resolve(timeout);
		await bounded(firstDone);
		expect(f.records).toEqual(["second", "first"]);
		expect(f.payloads().map((p) => [p.request_id, p.status])).toEqual([
			["second", "answered"],
			["first", "timed_out"],
		]);
	});
	it.each([answer, timeout, cancelled])(
		"R3 resumed $status retains original ID and excludes cancellation",
		async (response) => {
			const f = await fixture();
			f.ctx.ui.question = vi.fn(async () => response);
			f.harness.sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "toolCall", id: "resumed", name: "ask_user_question", arguments: args }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "fixture",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 1,
			});
			const done = f.completed("resumed");
			const runner = f.harness.getExtensionRunner();
			runner.setUIContext(f.ctx.ui, "tui");
			await runner.emit({ type: "session_start", reason: "resume" });
			if (response.status !== "cancelled") await bounded(done);
			await runner.emit({ type: "session_start", reason: "reload" });
			expect(f.ctx.ui.question).toHaveBeenCalledOnce();
			expect(f.payloads()).toEqual(
				response.status === "cancelled"
					? []
					: [expect.objectContaining({ request_id: "resumed", status: response.status })],
			);
			expect(f.records).toEqual(response.status === "cancelled" ? [] : ["resumed"]);
		},
	);
	it("R5 emitter returns without config or trust preparation when hooks are inactive", async () => {
		const f = await fixture("excluded");
		const getSources = vi.spyOn(f.ctx, "getLoadedHookSources");
		const read = vi.spyOn(FileHookStateStorage.prototype, "read");
		const emission = emitAskUserNotification(
			{ events: createEventBus() },
			f.ctx,
			{ requestId: "no-handlers", questions: [], timeoutMs: 1800000, waitForAnswer: true },
			timeout,
			"claude",
		);
		expect(getSources).not.toHaveBeenCalled();
		expect(read).not.toHaveBeenCalled();
		await emission;
	});
	it.each([true, false])(
		"R5 settlement waitForAnswer=%s completes while trust preparation is suspended",
		async (waitForAnswer) => {
			const f = await fixture();
			const gate = Promise.withResolvers<void>();
			const entered = Promise.withResolvers<void>();
			// Observe the user-message boundary without starting an unrelated provider turn (and Stop hooks).
			const userMessage = vi.spyOn(f.harness.session, "sendUserMessage").mockResolvedValue();
			const original = FileHookStateStorage.prototype.readAsync;
			vi.spyOn(FileHookStateStorage.prototype, "readAsync").mockImplementation(async function (
				this: FileHookStateStorage,
				scope,
			) {
				entered.resolve();
				await gate.promise;
				return original.call(this, scope);
			});
			const syncRead = vi.spyOn(FileHookStateStorage.prototype, "read");
			const done = f.completed("gated");
			const result = await bounded(f.tool.execute("gated", { ...args, waitForAnswer }, undefined, undefined, f.ctx));
			await bounded(entered.promise);
			expect(result.details).toMatchObject({ status: waitForAnswer ? "answered" : "pending" });
			expect(f.payloads()).toEqual([]);
			expect(syncRead).not.toHaveBeenCalled();
			expect(userMessage).toHaveBeenCalledTimes(waitForAnswer ? 0 : 1);
			gate.resolve();
			await bounded(done);
			expect(f.records).toEqual(["gated"]);
		},
	);
	it.each([true, false])("R5 settlement waitForAnswer=%s does not await command completion", async (waitForAnswer) => {
		const f = await fixture();
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const userMessage = vi.spyOn(f.harness.session, "sendUserMessage").mockResolvedValue();
		const original = commandRunner.runCommandHook;
		vi.spyOn(commandRunner, "runCommandHook").mockImplementation(async (...options) => {
			entered.resolve();
			await gate.promise;
			return original(...options);
		});
		const done = f.completed("command-gated");
		const result = await bounded(
			f.tool.execute("command-gated", { ...args, waitForAnswer }, undefined, undefined, f.ctx),
		);
		await bounded(entered.promise);
		expect(result.details).toMatchObject({ status: waitForAnswer ? "answered" : "pending" });
		expect(userMessage).toHaveBeenCalledTimes(waitForAnswer ? 0 : 1);
		expect(f.records).toEqual([]);
		gate.resolve();
		await bounded(done);
		expect(f.payloads()).toHaveLength(1);
		expect(f.records).toEqual(["command-gated"]);
	});
	it("R5 no Notification handlers skips trust reads even with contended lock directories", async () => {
		const f = await fixture();
		writeFileSync(f.hooksPath, JSON.stringify({ hooks: {} }));
		mkdirSync(join(f.hooksPath, "..", "hooks-state.json.lock"));
		const read = vi.spyOn(FileHookStateStorage.prototype, "read");
		const readAsync = vi.spyOn(FileHookStateStorage.prototype, "readAsync");
		await f.tool.execute("no-handlers", args, undefined, undefined, f.ctx);
		await bounded(f.notificationFinished);
		expect(read).not.toHaveBeenCalled();
		expect(readAsync).not.toHaveBeenCalled();
		expect(f.payloads()).toEqual([]);
	});
	it.each([undefined, "/fixture/session.jsonl"])(
		"R7 typed payload declares optional transcript_path %s",
		async (transcriptPath) => {
			const f = await fixture("excluded");
			vi.spyOn(f.ctx.sessionManager, "getSessionFile").mockReturnValue(transcriptPath);
			const wire = buildNotificationHookInput({ kind: "ask-user-timeout", message: "fixture" }, f.ctx);
			if (wire.event !== "Notification") throw new Error("wrong wire variant");
			expect(wire.transcript_path).toBe(transcriptPath);
			expect(Object.hasOwn(wire, "transcript_path")).toBe(transcriptPath !== undefined);
		},
	);
});
