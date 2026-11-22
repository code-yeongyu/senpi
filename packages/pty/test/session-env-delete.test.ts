import process from "node:process";
import { describe, expect, it } from "vitest";
import { loadNativePty, type NativePtyLoadResult } from "../src/native-loader.ts";
import { TerminalSession } from "../src/session.ts";

const posix = process.platform !== "win32";
// Shell parameter expansion, not a JS template: prints HOME, or "unset" when the child has no HOME.
const SHELL_SCRIPT = ["printf '%s' \"$", '{HOME-unset}"'].join("");
const native = loadNativePty();
const pipeOnly: NativePtyLoadResult = {
	native: null,
	diagnostic: {
		code: "native-unavailable",
		runtime: "node",
		host: "test-host",
		attemptedPath: "/missing/senpi_pty.node",
		attemptedPaths: ["/missing/senpi_pty.node"],
		message: "test native unavailable",
	},
};

// senpi#2908: an override set to `undefined` removes the variable from the child on every backend.
describe.runIf(posix && process.env.HOME !== undefined)("TerminalSession env deletion", () => {
	it.each([
		["native", native.native === null ? undefined : native],
		["pipe-fallback", pipeOnly],
	] as const)("%s backend leaves a variable overridden with undefined out of the child", async (backend, load) => {
		if (load === undefined) return;
		const session = new TerminalSession(
			{ command: "/bin/sh", args: ["-c", SHELL_SCRIPT], env: { HOME: undefined } },
			{ nativeLoadResult: load },
		);
		let output = "";
		session.onData((chunk) => {
			output += chunk.toString("utf8");
		});
		session.start();
		await session.waitExit();
		expect(session.backend).toBe(backend);
		expect(output.trim()).toBe("unset");
	});
});
