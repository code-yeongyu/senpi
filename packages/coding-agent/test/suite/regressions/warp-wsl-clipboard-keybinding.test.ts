import type * as Fs from "node:fs";
import type { Stats } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof Fs>();
	return {
		...fs,
		statSync: (path: string, ...args: unknown[]) =>
			path === "/run/WSL/123_interop"
				? ({ isSocket: () => true } as Stats)
				: Reflect.apply(fs.statSync, fs, [path, ...args]),
	};
});

afterEach(() => {
	vi.unstubAllEnvs();
	Object.defineProperty(process, "platform", platformDescriptor);
	vi.restoreAllMocks();
	vi.resetModules();
});

describe("Warp on WSL clipboard shortcuts", () => {
	it.each([
		["direct Warp on WSL", "linux", {}, true, true],
		["other WSL terminal", "linux", { WARP_SESSION_ID: "" }, false, true],
		["Warp on Linux", "linux", { WSL_INTEROP: "", WSL_DISTRO_NAME: "" }, true, false],
		["Warp over SSH", "linux", { SSH_CONNECTION: "remote" }, false, true],
		["Warp through tmux", "linux", { TMUX: "mux" }, false, true],
		["native Windows", "win32", {}, false, true],
	] as const)("%s retains the appropriate paste chords", async (_name, platform, overrides, ctrlV, altV) => {
		Object.defineProperty(process, "platform", { value: platform, configurable: true });
		for (const name of [
			"WARP_TERMINAL_SESSION_UUID",
			"WSLENV",
			"SSH_CONNECTION",
			"SSH_CLIENT",
			"SSH_TTY",
			"TMUX",
			"STY",
			"TMUX_PANE",
			"ZELLIJ",
		])
			vi.stubEnv(name, "");
		for (const [name, value] of Object.entries({
			WARP_SESSION_ID: "warp-session",
			WSL_INTEROP: "/run/WSL/123_interop",
			WSL_DISTRO_NAME: "Ubuntu",
			...overrides,
		}))
			vi.stubEnv(name, value);
		vi.resetModules();
		// Defaults are evaluated at module load, after each simulated terminal environment is installed.
		const { KeybindingsManager } = await import("../../../src/core/keybindings.ts");
		const bindings = new KeybindingsManager();
		expect(bindings.matches("\x16", "app.clipboard.pasteImage")).toBe(ctrlV);
		expect(bindings.matches("\x1bv", "app.clipboard.pasteImage")).toBe(altV);

		const rebound = new KeybindingsManager({ "app.clipboard.pasteImage": "ctrl+y" });
		expect(rebound.matches("\x16", "app.clipboard.pasteImage")).toBe(false);
		expect(rebound.matches("\x1bv", "app.clipboard.pasteImage")).toBe(false);
		expect(rebound.matches("\x19", "app.clipboard.pasteImage")).toBe(true);
	});
});
