import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MouseRegion, Text } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR, getDebugLogPath } from "../../../src/config.ts";
import {
	restoreInteractiveStderr,
	takeOverInteractiveStderr,
} from "../../../src/modes/interactive/interactive-stderr-guard.ts";
import { createInteractiveTui } from "../../../src/modes/interactive/tui-renderer.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

function createHarness() {
	const directory = mkdtempSync(join(tmpdir(), "hidden-stderr-mouse-"));
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	vi.stubEnv(ENV_AGENT_DIR, directory);
	vi.stubEnv("PI_TUI_KEYBOARD_PROTOCOL", "0");
	vi.stubEnv("WT_SESSION", "mouse-regression");
	const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
	cleanups.push(() => {
		if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
		else Reflect.deleteProperty(process.stdout, "isTTY");
	});
	vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
	vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
	vi.spyOn(process, "kill").mockReturnValue(true);
	const output: string[] = [];
	const errors: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		output.push(String(chunk));
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
		errors.push(String(chunk));
		return true;
	});

	takeOverInteractiveStderr();
	const tui = createInteractiveTui({
		tuiMode: "regular",
		showHardwareCursor: false,
		logDirectory: directory,
	});
	cleanups.push(() => {
		tui.stop();
		restoreInteractiveStderr();
	});
	let clicks = 0;
	tui.addChild(
		new MouseRegion(new Text("exploration group", 0, 0), (event) => {
			if (event.type === "click") clicks++;
			return event.type === "press" || event.type === "click" ? { handled: true } : undefined;
		}),
	);
	tui.start();
	tui.acquireMouseCapture("always");
	tui.renderNow(true);
	const click = () => process.stdin.emit("data", "\x1b[<0;1;1M\x1b[<0;1;1m");
	click();
	expect(clicks).toBe(1);
	tui.renderNow();
	return { tui, directory, output, errors, click, clicks: () => clicks };
}

describe("hidden diagnostics with regular-mode mouse capture", () => {
	test("keeps the frame and mouse anchor when console and stream diagnostics are hidden", () => {
		const harness = createHarness();
		const redraws = harness.tui.fullRedraws;
		console.warn("SECRET_TOKEN=console-secret");
		process.stderr.write(Buffer.from("hidden direct diagnostic\n"));
		process.stdout.write("hidden stdout diagnostic\n");
		harness.click();
		harness.tui.renderNow();

		expect(harness.tui.fullRedraws).toBe(redraws);
		expect(harness.clicks()).toBe(2);
		expect(harness.errors).toEqual([]);
		expect(harness.output.join("")).not.toContain("hidden stdout diagnostic");
		const log = readFileSync(getDebugLogPath(), "utf8");
		expect(log).toContain("SECRET_TOKEN=[REDACTED]");
		expect(log).toContain("hidden direct diagnostic");
		expect(log).toContain("hidden stdout diagnostic");
		expect(log).not.toContain("console-secret");
	});

	test("invalidates the frame when a failed log sink exposes redacted stderr", () => {
		const harness = createHarness();
		const redraws = harness.tui.fullRedraws;
		const blockedParent = join(harness.directory, "not-a-directory");
		writeFileSync(blockedParent, "fixture");
		vi.stubEnv(ENV_AGENT_DIR, join(blockedParent, "agent"));
		let callbackError: Error | null | undefined;
		const accepted = process.stderr.write("SECRET_TOKEN=fallback-secret\n", (error) => {
			callbackError = error;
		});
		harness.click();
		expect(harness.clicks()).toBe(1);
		harness.tui.renderNow();

		expect(accepted).toBe(false);
		expect(callbackError).toBeInstanceOf(Error);
		expect(harness.errors.join("")).toContain("SECRET_TOKEN=[REDACTED]");
		expect(harness.errors.join("")).not.toContain("fallback-secret");
		expect(harness.tui.fullRedraws).toBe(redraws + 1);
	});
});
