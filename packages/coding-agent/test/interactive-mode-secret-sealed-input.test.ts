import { expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

// D11 secret phase S5-5 (senpi#4249): the TUI's own `ctx.ui.input` routes a secret prompt through the terminal's sealed
// race, so the terminal's answer reaches the shared latch. Only the dialog plumbing and the TUI component are stubbed.

type Stub = Record<string, unknown>;

function mode(sealed: unknown) {
	const typed = Promise.withResolvers<string | undefined>();
	const self = Object.create(InteractiveMode.prototype) as Stub;
	Object.assign(self, {
		mcpLocalPresenter: { sealed },
		withBlockedHostDialog: (_id: string, _title: string, run: () => Promise<unknown>) => run(),
		showExtensionInput: vi.fn(() => typed.promise),
	});
	const create = Reflect.get(InteractiveMode.prototype, "createExtensionUIContext") as (this: Stub) => {
		input: (title: string, placeholder?: string, opts?: { secret?: boolean }) => Promise<string | undefined>;
	};
	return { ui: create.call(self), typed, self };
}

it("a TUI secret prompt with a sealed route goes through the race, and the TUI answer reaches the shared latch", async () => {
	const result = Promise.withResolvers<string | undefined>();
	const sealed = {
		open: vi.fn(() => ({ id: "request-1", result: result.promise })),
		requests: { answerLocal: vi.fn() },
	};
	const { ui, typed } = mode(sealed);
	const answered = ui.input("API key", undefined, { secret: true });
	expect(sealed.open).toHaveBeenCalledWith(
		"API key",
		undefined,
		expect.objectContaining({ secret: true, signal: expect.any(AbortSignal) }),
	);
	typed.resolve("typed-in-the-tui");
	await Promise.resolve();
	await Promise.resolve();
	expect(sealed.requests.answerLocal).toHaveBeenCalledWith("request-1", "typed-in-the-tui");
	result.resolve("typed-in-the-tui");
	expect(await answered).toBe("typed-in-the-tui");
});

it("a non-secret TUI input never touches the sealed route", async () => {
	const sealed = { open: vi.fn(), requests: { answerLocal: vi.fn() } };
	const { ui, typed } = mode(sealed);
	const answered = ui.input("Name", undefined, {});
	typed.resolve("plain");
	expect(await answered).toBe("plain");
	expect(sealed.open).not.toHaveBeenCalled();
});
