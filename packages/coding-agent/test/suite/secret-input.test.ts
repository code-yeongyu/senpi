import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createRpcConnectionHandler, type RpcConnectionHandler } from "../../src/modes/rpc/connection-handler.ts";
import { ConnectionRoles } from "../../src/modes/rpc/connection-roles.ts";
import { createExtensionLoginInteraction } from "../../src/core/extensions/builtin/oauth-login-interaction.ts";
import { createRpcLoginPromptCallbacks } from "../../src/modes/rpc/login-prompts.ts";
import { ExtensionInputComponent } from "../../src/modes/interactive/components/extension-input.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { makeHarness, makeSink, type Harness } from "./rpc-connection-harness.ts";
import { createTestUiContext } from "./harness.ts";
import type { ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { AttachDialogs } from "../../src/modes/interactive/attach-dialogs.ts";
import { AnswerRefusedError } from "../../src/modes/interactive/attach-client.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import type { TUI } from "@earendil-works/pi-tui";
import { createTuiLifecycle, invoke } from "./tui-lifecycle-harness.ts";

const resources: Array<{ dir: string; harness: Harness; handler: RpcConnectionHandler }> = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const { dir, harness, handler } of resources.splice(0)) {
		await handler.dispose();
		harness.cleanup();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("settles private input when its owner tears down the editor", async () => {
	const cleanups: Array<() => unknown> = [];
	try {
		const { mode } = await createTuiLifecycle(cleanups);
		const ui = invoke(mode, "createExtensionUIContext") as ExtensionUIContext;
		const pending = ui.input("Private", undefined, { secret: true });
		invoke(mode, "hideExtensionInput");
		await expect(pending).resolves.toBeUndefined();
	} finally {
		for (const cleanup of cleanups.reverse()) await cleanup();
	}
});

async function fixture(shared = false, inherited: readonly string[] = []) {
	const dir = mkdtempSync(join(tmpdir(), "secret-input-"));
	const harness = makeHarness(dir);
	const collected = makeSink();
	let connection = "a";
	const capabilities = new Map<string, readonly string[]>();
	const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink, {
		capabilities: inherited,
		connectionRoles: new ConnectionRoles(),
		...(shared
			? {
					sessionId: "secret-session",
					clientInfo: {
						connectionId: () => connection,
						setCapabilities: (id: string | undefined, caps: readonly string[]) => capabilities.set(id!, caps),
						hasCapability: (id: string, cap: string) => capabilities.get(id)?.includes(cap) === true,
					},
				}
			: {}),
	});
	resources.push({ dir, harness, handler });
	await handler.ready;
	const ui = harness.runtimeHost.session.extensionRunner.getUIContext();
	const send = (frame: object) => handler.handleInputLine(JSON.stringify(frame));
	const handshake = async (id: string, secret: boolean) => {
		connection = id;
		await send({
			type: "set_client_info",
			width: 80,
			capabilities: ["interactive_user", ...(secret ? ["secret_input_v1"] : [])],
		});
	};
	return {
		ui,
		send,
		handshake,
		collected,
		harness,
		select: (id: string) => {
			connection = id;
		},
	};
}

// senpi#5108: capability truth belongs to the selected connection, not the binding's last handshake.
it.each([
	["a", "b"],
	["b", "a"],
])("isolates secret support with handshake order %s then %s", async (first, second) => {
	const f = await fixture(true);
	for (const id of [first, second]) await f.handshake(id, id === "a");
	f.select("b");
	const abort = new AbortController();
	const refused = f.ui.input("Private", undefined, { secret: true, signal: abort.signal });
	try {
		expect(f.collected.messages().filter((r) => r.method === "input")).toHaveLength(0);
		await expect(refused).rejects.toMatchObject({ code: "secret_input_unavailable", reason: "client_unsupported" });
	} finally {
		abort.abort();
		await refused.catch(() => undefined);
	}
	f.select("a");
	const asked = f.collected.waitFor((r) => r.method === "input");
	const value = f.ui.input("Private", undefined, { secret: true });
	const request = await asked;
	expect(request.secret).toBe(true);
	f.select("b");
	await f.send({
		type: "extension_ui_response",
		id: "foreign",
		uiRequestId: request.id,
		answerId: "foreign",
		secret: true,
		value: "bad",
	});
	expect(f.collected.messages().find((r) => r.id === "foreign")).toMatchObject({
		success: false,
		error: "secret_answer_refused",
	});
	f.select("a");
	await f.send({
		type: "extension_ui_response",
		id: "owner",
		uiRequestId: request.id,
		answerId: "owner",
		secret: true,
		value: "",
	});
	await expect(value).resolves.toBe("");
});

it("refuses inherited support before presentation and requires the interactive role", async () => {
	const f = await fixture(false, ["secret_input_v1", "interactive_user"]);
	for (const caps of [undefined, ["secret_input_v1"]]) {
		if (caps) await f.send({ type: "set_client_info", capabilities: caps });
		const abort = new AbortController();
		const pending = f.ui.input("Private", undefined, { secret: true, signal: abort.signal });
		try {
			expect(f.collected.messages().some((r) => r.method === "input")).toBe(false);
			await expect(pending).rejects.toMatchObject({ reason: "client_unsupported" });
		} finally {
			abort.abort();
			await pending.catch(() => undefined);
		}
	}
});

it("keeps exact values private and authorizes before receipts or admission", async () => {
	const f = await fixture();
	await f.handshake("a", true);
	const sentinel = ` ${crypto.randomUUID()} \u00e9 `;
	const requested = f.collected.waitFor((r) => r.method === "input");
	const pending = f.ui.input("Private", undefined, { secret: true });
	const frame = await requested;
	expect(frame.secret).toBe(true);
	const admit = vi.spyOn(f.harness.runtimeHost.session, "admitHumanAnswer");
	for (const response of [
		{ value: sentinel },
		{ secret: true, value: sentinel, confirmed: true },
		{ secret: true, value: sentinel, cancelled: true },
		{ secret: true, value: "bad\nvalue" },
	]) {
		await f.send({
			type: "extension_ui_response",
			id: "invalid",
			uiRequestId: frame.id,
			answerId: "bad",
			...response,
		});
		expect(f.collected.messages().at(-1)).toMatchObject({ success: false, error: "invalid_secret_response" });
	}
	expect(admit).not.toHaveBeenCalled();
	const answer = {
		type: "extension_ui_response",
		id: "good",
		uiRequestId: frame.id,
		answerId: "one",
		secret: true,
		value: sentinel,
	};
	await f.send(answer);
	expect((await pending) === sentinel).toBe(true);
	await f.send(answer);
	expect(f.collected.messages().at(-1)).toMatchObject({ success: true, disposition: "replay" });
	expect(admit).toHaveBeenCalledTimes(1);
	await f.send({ type: "get_state", id: "state" });
	const outputs = JSON.stringify([f.collected.messages(), f.harness.runtimeHost.session.messages]);
	expect(outputs.includes(sentinel)).toBe(false);
	expect(outputs.includes(Buffer.from(sentinel).toString("base64"))).toBe(false);
});

it("rejects progress without extending the authoritative deadline and refuses a late answer", async () => {
	const f = await fixture();
	await f.handshake("a", true);
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
	const pending = f.ui.input("Private", undefined, { secret: true, timeout: 1000 });
	await Promise.resolve();
	const frame = f.collected.messages().find((r) => r.method === "input");
	expect(frame).toMatchObject({ secret: true, deadlineAtMs: Date.now() + 1000 });
	await vi.advanceTimersByTimeAsync(500);
	await f.send({ type: "extension_ui_progress", id: frame!.id, answers: {} });
	await f.send({ type: "get_state", id: "snapshot" });
	await vi.advanceTimersByTimeAsync(500);
	await expect(pending).resolves.toBeUndefined();
	await f.send({
		type: "extension_ui_response",
		id: "late",
		uiRequestId: frame!.id,
		answerId: "late",
		secret: true,
		value: "late",
	});
	expect(f.collected.messages().at(-1)).toMatchObject({ success: false });
	expect(f.collected.messages().filter((r) => r.type === "secret_input_settled")).toEqual([
		expect.objectContaining({ id: frame!.id, outcome: "timed_out" }),
	]);
});

it("does not overflow a finite positive deadline into immediate expiry", async () => {
	const f = await fixture();
	await f.handshake("a", true);
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
	const abort = new AbortController();
	const pending = f.ui.input("Private", undefined, { secret: true, timeout: 2 ** 31, signal: abort.signal });
	try {
		await vi.advanceTimersByTimeAsync(1);
		expect(f.collected.messages().some((r) => r.type === "secret_input_settled")).toBe(false);
	} finally {
		abort.abort();
		await pending;
	}
});

it("maps typed login secrets only on supporting contexts without a plain retry", async () => {
	for (const supported of [false, true]) {
		const input = vi.fn<ExtensionUIContext["input"]>(async () => "synthetic");
		const ui = createTestUiContext({ input, ...(supported ? { capabilities: { secretInput: true } } : {}) });
		const signal = new AbortController().signal;
		await createRpcLoginPromptCallbacks(ui, signal).onPrompt({
			type: "secret",
			message: "Credential",
			placeholder: "hint",
		});
		await createExtensionLoginInteraction({ ui, mode: "rpc" }, { providerLabel: "fixture" }).prompt({
			type: "secret",
			message: "Credential",
			placeholder: "hint",
		});
		for (const call of input.mock.calls) {
			expect(call).toEqual([
				"Credential",
				"hint",
				expect.objectContaining(
					supported ? { secret: true, signal: expect.any(AbortSignal) } : { signal: expect.any(AbortSignal) },
				),
			]);
			if (!supported) expect(call[2]).not.toHaveProperty("secret");
		}
	}
});

it("masks input before rendering and clears private editing state on disposal", () => {
	initTheme("dark");
	const sentinel = crypto.randomUUID();
	const submit = vi.fn();
	const component = new ExtensionInputComponent("Credential", undefined, submit, () => {}, { secret: true });
	component.handleInput(sentinel);
	expect(component.render(80).join("\n").includes(sentinel)).toBe(false);
	component.handleInput("\n");
	expect(submit.mock.calls[0]?.[0] === sentinel).toBe(true);
	component.dispose();
	expect(component.render(80).join("\n").includes(sentinel)).toBe(false);
});

it("refuses headless secrets without changing singleton identity or hasUI", async () => {
	const f = await fixture();
	const runner = f.harness.runtimeHost.session.extensionRunner;
	runner.setUIContext(undefined, "print");
	const ui = runner.getUIContext();
	expect(runner.hasUI()).toBe(false);
	await expect(ui.input("ordinary")).resolves.toBeUndefined();
	await expect(ui.input("private", undefined, { secret: true })).rejects.toMatchObject({
		code: "secret_input_unavailable",
		reason: "headless",
	});
	runner.setUIContext(undefined, "json");
	expect(runner.getUIContext()).toBe(ui);
	expect(runner.hasUI()).toBe(false);
});

it("reoffers an empty attach input only until its original deadline", async () => {
	initTheme("dark");
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
	const ui = { requestRender() {}, setFocus() {} } as unknown as TUI;
	const answer = vi.fn<(response: import("../../src/modes/rpc/rpc-types.ts").RpcExtensionUIResponse) => Promise<void>>(
		async () => {
			throw new AnswerRefusedError("invalid_secret_response");
		},
	);
	const dialogs = new AttachDialogs(
		ui,
		new KeybindingsManager(),
		answer,
		() => {},
		() => {},
	);
	const request = {
		type: "extension_ui_request",
		id: "private",
		method: "input",
		title: "Private",
		secret: true,
		timeout: 1000,
		deadlineAtMs: Date.now() + 1000,
	} as const;
	try {
		dialogs.accept(request);
		await vi.advanceTimersByTimeAsync(500);
		dialogs.handleInput("synthetic");
		dialogs.handleInput("\n");
		await Promise.resolve();
		await Promise.resolve();
		expect(dialogs.render(80).join("\n").includes("synthetic")).toBe(false);
		expect(dialogs.active).toBe(true);
		dialogs.render(20);
		await vi.advanceTimersByTimeAsync(500);
		expect(dialogs.active).toBe(false);
		expect(answer).toHaveBeenCalledTimes(2);
		expect(answer.mock.calls[0]?.[0]).toMatchObject({ secret: true, answerId: expect.any(String) });
	} finally {
		dialogs.dispose();
	}
	const reattached = new AttachDialogs(
		ui,
		new KeybindingsManager(),
		answer,
		() => {},
		() => {},
	);
	reattached.accept(request);
	expect(reattached.active).toBe(false);
	reattached.dispose();
});

it("destroys terminal paste, undo and kill state and refuses lossy input", () => {
	initTheme("dark");
	const submit = vi.fn();
	const component = new ExtensionInputComponent("Private", undefined, submit, () => {}, { secret: true });
	component.handleInput("\x1b[200~line\nbreak\x1b[201~");
	expect(component.render(80).join("\n")).toContain("single line");
	component.handleInput("\n");
	expect(submit).toHaveBeenCalledWith("");
	component.handleInput("synthetic");
	component.handleInput("\x15");
	component.dispose();
	component.handleInput("\x19");
	expect(component.render(80).join("\n").includes("*")).toBe(false);
});
