// senpi#5323: interactive mode writes OSC 7501 program status to its own terminal, once per change.
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_COMMAND } from "../../src/config.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createFakeInteractiveMode } from "./helpers/ask-user-async-fake-mode.ts";

const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function setStdoutTty(value: boolean): void {
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
}

function host() {
	const fake = createFakeInteractiveMode();
	const terminal = { write: vi.fn(), setTitle: vi.fn(), rows: 36, columns: 120 };
	Object.assign(fake.ui, { terminal });
	return { ui: fake.createExtensionUIContext(), write: terminal.write };
}

beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});
afterEach(() => {
	if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
	else delete (process.stdout as { isTTY?: boolean }).isTTY;
});

describe("interactive program status (senpi#5323)", () => {
	it("writes each change once with the branded app, and a clear only after a report", () => {
		setStdoutTty(true);
		const { ui, write } = host();
		ui.setProgramStatus(undefined);
		ui.setProgramStatus({ state: "working" });
		ui.setProgramStatus({ state: "working" });
		ui.setProgramStatus({ state: "blocked", kind: "permission", message: "Allow bash?" });
		ui.setProgramStatus(undefined);
		ui.setProgramStatus(undefined);
		expect(write.mock.calls.map(([data]) => data)).toEqual([
			`\x1b]7501;state=working:app=${APP_COMMAND}\x1b\\`,
			`\x1b]7501;state=blocked:kind=permission:app=${APP_COMMAND}:msg=${Buffer.from("Allow bash?").toString("base64")}\x1b\\`,
			"\x1b]7501;state=clear\x1b\\",
		]);
	});

	it("writes nothing when stdout is not a terminal", () => {
		setStdoutTty(false);
		const { ui, write } = host();
		ui.setProgramStatus({ state: "working" });
		ui.setProgramStatus(undefined);
		expect(write).not.toHaveBeenCalled();
	});

	it("emits herdr:blocked kind=auth around loginProvider and clears on both success and error", async () => {
		const fake = createFakeInteractiveMode();
		const login = vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValueOnce(undefined);
		Object.assign(fake.session, {
			modelRegistry: { authStorage: { takeReplacement: vi.fn(() => undefined) } },
			modelRuntime: { login },
		});
		const loginProvider = (
			fake as unknown as {
				loginProvider(
					dialog: { signal: AbortSignal },
					providerId: string,
					providerName: string,
					method: "api_key" | "oauth",
				): Promise<void>;
			}
		).loginProvider.bind(fake);
		const controller = new AbortController();

		await loginProvider({ signal: controller.signal }, "anthropic", "Anthropic", "oauth");
		expect(fake.session.emitExtensionEvent.mock.calls).toHaveLength(2);
		const [firstCall, secondCall] = fake.session.emitExtensionEvent.mock.calls;
		expect(firstCall?.[0]).toBe("herdr:blocked");
		expect(firstCall?.[1]).toMatchObject({ active: true, kind: "auth", label: "Sign in to Anthropic" });
		const firstId = (firstCall?.[1] as { id?: string } | undefined)?.id;
		expect(typeof firstId).toBe("string");
		expect(secondCall).toEqual(["herdr:blocked", { active: false, id: firstId }]);

		fake.session.emitExtensionEvent.mockClear();
		login.mockRejectedValueOnce(new Error("cancelled"));
		await expect(loginProvider({ signal: controller.signal }, "openai", "OpenAI", "api_key")).rejects.toThrow(
			"cancelled",
		);
		expect(fake.session.emitExtensionEvent.mock.calls).toHaveLength(2);
		const [errStartCall, errEndCall] = fake.session.emitExtensionEvent.mock.calls;
		expect(errStartCall?.[0]).toBe("herdr:blocked");
		expect(errStartCall?.[1]).toMatchObject({ active: true, kind: "auth", label: "Sign in to OpenAI" });
		const errId = (errStartCall?.[1] as { id?: string } | undefined)?.id;
		expect(typeof errId).toBe("string");
		expect(errEndCall).toEqual(["herdr:blocked", { active: false, id: errId }]);
	});
});
