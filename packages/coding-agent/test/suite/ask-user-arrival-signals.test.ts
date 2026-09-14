// Refs #1645: arrival notification and exactly-once blocked lifetime.
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuestionResponse } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createFakeInteractiveMode } from "./helpers/ask-user-async-fake-mode.ts";
import { ASYNC_QUESTIONS, createAskUserDelivery } from "./helpers/ask-user-delivery.ts";

const cleanups: Array<() => void> = [];
beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});
afterEach(() => {
	for (const clean of cleanups.splice(0).reverse()) clean();
	vi.useRealTimers();
});
function signalHost(bell = true) {
	const fake = createFakeInteractiveMode();
	const terminal = { write: vi.fn(), setTitle: vi.fn(), rows: 36, columns: 120 };
	const emitExtensionEvent = vi.fn();
	Object.assign(fake.ui, { terminal });
	Object.assign(fake.session, {
		emitExtensionEvent,
		settingsManager: SettingsManager.inMemory({ askUser: { ...{ bell } } }),
	});
	Object.assign(fake, { getNormalTerminalTitle: () => "normal-title", questionArrivalEpochMs: Date.now() });
	const controller = new AbortController();
	cleanups.push(() => controller.abort());
	const request = {
		requestId: "auth",
		waitForAnswer: false,
		timeoutMs: 60_000,
		questions: [
			{ id: "auth", header: "Auth", question: "Which flow?", options: [{ label: "OAuth" }], multiSelect: false },
		],
	};
	return { fake, terminal, emitExtensionEvent, request, controller };
}

describe("ask-user arrival signals", () => {
	it("defaults the bell setting on and honors an explicit off value", () => {
		expect(SettingsManager.inMemory().getAskUserSettings()).toMatchObject({ bell: true });
		expect(SettingsManager.inMemory({ askUser: { ...{ bell: false } } }).getAskUserSettings()).toMatchObject({
			bell: false,
		});
	});
	it("layers the pending header into the title and restores the normal title", async () => {
		const h = signalHost();
		const pending = h.fake.createExtensionUIContext().question!(h.request, { signal: h.controller.signal });
		expect(h.terminal.setTitle).toHaveBeenLastCalledWith("? Auth");
		h.controller.abort();
		await pending;
		expect(h.terminal.setTitle).toHaveBeenLastCalledWith("normal-title");
	});
	it.each([true, false])("writes one bell per fresh arrival when enabled=%s", async (bell) => {
		const h = signalHost(bell);
		const pending = h.fake.createExtensionUIContext().question!(h.request, { signal: h.controller.signal });
		const replay = h.fake.createExtensionUIContext().question!(h.request, { signal: h.controller.signal });
		expect(h.terminal.write.mock.calls.filter(([value]) => value === "\x07")).toHaveLength(bell ? 1 : 0);
		h.controller.abort();
		await Promise.all([pending, replay]);
	});
	it("does not ring for a hydrated host question", async () => {
		const h = signalHost();
		const host = h.fake as unknown as { handleHostUiRequest(request: object): Promise<unknown> };
		const pending = host.handleHostUiRequest({
			id: "ui-replay",
			method: "question",
			requestId: "auth",
			waitForAnswer: false,
			questions: h.request.questions,
			timeout: 60_000,
			remainingMs: 60_000,
			askedAtMs: 0,
		});
		expect(h.terminal.write).not.toHaveBeenCalled();
		await h.fake.submitEditorText("/answer skip");
		await pending;
	});
	it("does not emit arrival events twice when a registered request is replayed", async () => {
		const delivery = await createAskUserDelivery();
		cleanups.push(() => delivery.harness.cleanup());
		const response = Promise.withResolvers<QuestionResponse>();
		const ctx = delivery.context(() => response.promise);
		const asked: unknown[] = [];
		const blocked: unknown[] = [];
		const runner = delivery.harness.getExtensionRunner();
		cleanups.push(runner.onBusEvent("ask-user:asked", (data) => asked.push(data)));
		cleanups.push(runner.onBusEvent("herdr:blocked", (data) => blocked.push(data)));
		const controller = new AbortController();
		cleanups.push(() => controller.abort());
		const args = { questions: ASYNC_QUESTIONS, waitForAnswer: false };
		await delivery.tool.execute("replayed", args, controller.signal, undefined, ctx);
		const settled = delivery.settled(ctx, "replayed");
		await delivery.tool.execute("replayed", args, controller.signal, undefined, ctx);
		expect(asked).toHaveLength(1);
		expect(blocked).toHaveLength(1);
		controller.abort();
		await settled;
		expect(blocked).toHaveLength(2);
	});
	for (const waitForAnswer of [true, false]) {
		it.each(["answered", "cancelled", "timed_out", "abort", "orphaned-after-restart"] as const)(
			`emits one blocked pair for wait=${waitForAnswer}, outcome=%s`,
			async (outcome) => {
				const delivery = await createAskUserDelivery();
				cleanups.push(() => delivery.harness.cleanup());
				const response = Promise.withResolvers<QuestionResponse>();
				const ctx = delivery.context(() => response.promise);
				const runner = delivery.harness.getExtensionRunner();
				const blocked: unknown[] = [];
				const asked: unknown[] = [];
				cleanups.push(runner.onBusEvent("herdr:blocked", (event) => blocked.push(event)));
				cleanups.push(runner.onBusEvent("ask-user:asked", (event) => asked.push(event)));
				const controller = new AbortController();
				cleanups.push(() => controller.abort());
				const execution = delivery.tool.execute(
					"arrival",
					{ questions: ASYNC_QUESTIONS, waitForAnswer },
					controller.signal,
					undefined,
					ctx,
				);
				const settled = delivery.settled(ctx, "arrival");
				expect(asked).toHaveLength(1);
				expect(blocked).toEqual([{ active: true, id: "arrival", label: "Library — Which library?" }]);
				if (outcome === "abort") controller.abort();
				else
					response.resolve({
						status: outcome,
						answers: outcome === "answered" ? { q1: { selected: ["OAuth"] } } : {},
						unanswered: outcome === "answered" ? [] : ["q1"],
					});
				await settled;
				await execution;
				controller.abort();
				response.resolve({ status: "cancelled", answers: {}, unanswered: ["q1"] });
				await Promise.resolve();
				expect(asked).toHaveLength(1);
				expect(blocked).toEqual([
					{ active: true, id: "arrival", label: "Library — Which library?" },
					{ active: false, id: "arrival" },
				]);
			},
		);
	}
	it.each(["select", "confirm", "input", "editor"])("pairs host %s dialog open and close", async (method) => {
		const h = signalHost();
		const done = Promise.withResolvers<string | boolean | undefined>();
		const methods: Record<string, string> = {
			select: "showExtensionSelector",
			confirm: "showExtensionConfirm",
			input: "showExtensionInput",
			editor: "showExtensionEditor",
		};
		Object.assign(h.fake, { [methods[method]!]: () => done.promise });
		const host = h.fake as unknown as { handleHostUiRequest(request: object): Promise<unknown> };
		const pending = host.handleHostUiRequest({
			id: "host-dialog",
			method,
			title: "Choose a flow",
			options: ["OAuth"],
		});
		expect(h.emitExtensionEvent).toHaveBeenCalledExactlyOnceWith("herdr:blocked", {
			active: true,
			id: "host-dialog",
			label: "Choose a flow",
		});
		done.resolve(method === "confirm" ? true : "OAuth");
		await pending;
		expect(h.emitExtensionEvent).toHaveBeenLastCalledWith("herdr:blocked", { active: false, id: "host-dialog" });
		expect(h.emitExtensionEvent).toHaveBeenCalledTimes(2);
	});
});
