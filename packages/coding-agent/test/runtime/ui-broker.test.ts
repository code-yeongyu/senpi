import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ExtensionRunner, noOpUIContext } from "../../src/core/extensions/runner.ts";
import type { ExtensionUIContext } from "../../src/core/extensions/types.ts";
import type { RpcExtensionUIRequest } from "../../src/modes/rpc/rpc-types.ts";
import { createRpcUiPresenter, RuntimeUiBroker } from "../../src/core/runtime/ui-broker.ts";
import { createInMemoryModelRegistry } from "../model-runtime-test-utils.ts";
import { createTestExtensionsResult } from "../utilities.ts";

afterEach(() => {
	vi.useRealTimers();
});

async function sessionlessRunner(): Promise<ExtensionRunner> {
	const extensions = await createTestExtensionsResult([]);
	return new ExtensionRunner(
		extensions.extensions,
		extensions.runtime,
		process.cwd(),
		undefined,
		await createInMemoryModelRegistry(AuthStorage.inMemory()),
		extensions.eventBus,
	);
}

function presenter(answers: {
	confirm?: boolean;
	select?: string;
	input?: string;
	editor?: string;
}): ExtensionUIContext {
	return {
		...noOpUIContext,
		confirm: async () => answers.confirm ?? false,
		select: async () => answers.select,
		input: async () => answers.input,
		editor: async () => answers.editor,
	};
}

describe("a runtime's UI broker (RT7)", () => {
	it("routes a sessionless runner's dialogs to the attached presenter", async () => {
		// Given a runner with no session whose broker has a presenter.
		const runner = await sessionlessRunner();
		const broker = new RuntimeUiBroker();
		runner.setUiBroker(broker);
		broker.attach(presenter({ confirm: true, select: "b", input: "typed", editor: "edited" }));
		// Then the runner has a UI, and every dialog kind returns the presenter's answer.
		expect(runner.hasUI()).toBe(true);
		const ui = runner.getUIContext();
		expect(await ui.confirm("Proceed?", "detail")).toBe(true);
		expect(await ui.select("Pick", ["a", "b"])).toBe("b");
		expect(await ui.input("Name", "placeholder")).toBe("typed");
		expect(await ui.editor("Edit", "prefill")).toBe("edited");
	});

	it("settles every dialog as an unbound UI does when no presenter is attached", async () => {
		const runner = await sessionlessRunner();
		const broker = new RuntimeUiBroker();
		runner.setUiBroker(broker);
		const ui = runner.getUIContext();
		expect(runner.hasUI()).toBe(false);
		expect(await ui.confirm("Proceed?", "detail")).toBe(false);
		expect(await ui.select("Pick", ["a"])).toBeUndefined();
		expect(await ui.input("Name")).toBeUndefined();
		expect(await ui.editor("Edit")).toBeUndefined();
	});

	it("drops back to the unbound UI when the presenter detaches", async () => {
		const runner = await sessionlessRunner();
		const broker = new RuntimeUiBroker();
		runner.setUiBroker(broker);
		const detach = broker.attach(presenter({ confirm: true }));
		expect(await runner.getUIContext().confirm("Proceed?", "")).toBe(true);
		detach();
		expect(runner.hasUI()).toBe(false);
		expect(await runner.getUIContext().confirm("Proceed?", "")).toBe(false);
	});

	it("lets one presenter own the broker at a time", () => {
		const broker = new RuntimeUiBroker();
		const detach = broker.attach(presenter({}));
		expect(() => broker.attach(presenter({}))).toThrow(/already attached/);
		detach();
		expect(() => broker.attach(presenter({}))).not.toThrow();
	});

	it("emits ui_prompt_start and ui_prompt_end around a presenter's dialog", async () => {
		const events: string[] = [];
		const ended = Promise.withResolvers<void>();
		const extensions = await createTestExtensionsResult([
			(pi) => {
				pi.on("ui_prompt_start", (event) => {
					events.push(`start:${event.kind}`);
				});
				pi.on("ui_prompt_end", (event) => {
					events.push(`end:${event.kind}`);
					ended.resolve();
				});
			},
		]);
		const runner = new ExtensionRunner(
			extensions.extensions,
			extensions.runtime,
			process.cwd(),
			undefined,
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
			extensions.eventBus,
		);
		const broker = new RuntimeUiBroker();
		runner.setUiBroker(broker);
		broker.attach(presenter({ confirm: true }));
		await runner.getUIContext().confirm("Proceed?", "");
		await ended.promise;
		expect(events).toEqual(["start:confirm", "end:confirm"]);
	});

	it("leaves a session's own UI binding unchanged", async () => {
		// Given a runner whose UI is bound the way a session binds it, with no broker.
		const runner = await sessionlessRunner();
		runner.setUIContext(presenter({ confirm: true }), "rpc");
		// Then it answers through that UI, as today.
		expect(runner.hasUI()).toBe(true);
		expect(await runner.getUIContext().confirm("Proceed?", "")).toBe(true);
	});
});

describe("the RPC presenter for a runtime with no session (RT7)", () => {
	function rpc() {
		const frames: RpcExtensionUIRequest[] = [];
		return { frames, presenter: createRpcUiPresenter((frame) => frames.push(frame)) };
	}

	it("asks with today's extension_ui_request frames and settles on the response", async () => {
		const { frames, presenter: p } = rpc();
		const answer = p.ui.select("Pick", ["a", "b"], { toolCallId: "call-1" });
		expect(frames).toHaveLength(1);
		const [frame] = frames;
		expect(frame).toMatchObject({
			type: "extension_ui_request",
			method: "select",
			title: "Pick",
			options: ["a", "b"],
			toolCallId: "call-1",
		});
		expect(p.respond({ type: "extension_ui_response", id: frame?.id ?? "", value: "b" })).toBe(true);
		expect(await answer).toBe("b");
	});

	it("maps confirm, input and editor responses as a session's RPC UI does", async () => {
		const { frames, presenter: p } = rpc();
		const confirmed = p.ui.confirm("Proceed?", "detail");
		const typed = p.ui.input("Name", "placeholder");
		const edited = p.ui.editor("Edit", "prefill");
		expect(frames.map((frame) => frame.method)).toEqual(["confirm", "input", "editor"]);
		p.respond({ type: "extension_ui_response", id: frames[0]?.id ?? "", confirmed: true });
		p.respond({ type: "extension_ui_response", id: frames[1]?.id ?? "", cancelled: true });
		p.respond({ type: "extension_ui_response", id: frames[2]?.id ?? "", value: "edited" });
		expect(await confirmed).toBe(true);
		expect(await typed).toBeUndefined();
		expect(await edited).toBe("edited");
	});

	it("settles a dialog with its default on timeout and on abort", async () => {
		vi.useFakeTimers();
		const { presenter: p } = rpc();
		const timedOut = p.ui.confirm("Proceed?", "", { timeout: 1000 });
		await vi.advanceTimersByTimeAsync(1000);
		expect(await timedOut).toBe(false);
		const controller = new AbortController();
		const aborted = p.ui.input("Name", undefined, { signal: controller.signal });
		controller.abort();
		expect(await aborted).toBeUndefined();
	});

	it("settles pending dialogs as cancelled when the connection goes away", async () => {
		const { presenter: p } = rpc();
		const confirmed = p.ui.confirm("Proceed?", "");
		const picked = p.ui.select("Pick", ["a"]);
		p.dispose();
		expect(await confirmed).toBe(false);
		expect(await picked).toBeUndefined();
	});

	it("ignores a response for an unknown request", () => {
		const { presenter: p } = rpc();
		expect(p.respond({ type: "extension_ui_response", id: "nope", value: "x" })).toBe(false);
	});
});
