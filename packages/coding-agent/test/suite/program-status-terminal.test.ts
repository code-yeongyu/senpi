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
});
