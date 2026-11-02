import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	clearConfigValueCache,
	resolveConfigValue,
	resolveConfigValueUncached,
} from "../src/core/resolve-config-value.ts";
import * as shellModule from "../src/utils/shell.ts";

describe("resolveConfigValue", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-config-value-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		clearConfigValueCache();
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		clearConfigValueCache();
		vi.restoreAllMocks();
	});

	test("resolves literals, environment templates, and escapes", async () => {
		process.env.TEST_CONFIG_LEFT = "left";
		process.env.TEST_CONFIG_RIGHT = "right";
		try {
			expect(await resolveConfigValue("literal-key")).toBe("literal-key");
			expect(await resolveConfigValue("$TEST_CONFIG_LEFT")).toBe("left");
			expect(await resolveConfigValue("$" + "{TEST_CONFIG_LEFT}_$TEST_CONFIG_RIGHT")).toBe("left_right");
			expect(await resolveConfigValue("$$TEST_CONFIG_LEFT")).toBe("$TEST_CONFIG_LEFT");
			expect(await resolveConfigValue("$!literal-$TEST_CONFIG_RIGHT")).toBe("!literal-right");
		} finally {
			delete process.env.TEST_CONFIG_LEFT;
			delete process.env.TEST_CONFIG_RIGHT;
		}
	});

	test("uses credential-scoped environment before process.env", async () => {
		process.env.TEST_CONFIG_SCOPED = "process";
		try {
			expect(await resolveConfigValue("$TEST_CONFIG_SCOPED", { TEST_CONFIG_SCOPED: "credential" })).toBe(
				"credential",
			);
		} finally {
			delete process.env.TEST_CONFIG_SCOPED;
		}
	});

	test("executes shell commands and trims their output", async () => {
		expect(await resolveConfigValue("!echo '  spaced-key  '")).toBe("spaced-key");
		expect(await resolveConfigValue("!printf 'line1\\nline2'")).toBe("line1\nline2");
		expect(await resolveConfigValue("!echo 'hello world' | tr ' ' '-'")).toBe("hello-world");
	});

	test("resolves a command without holding the event loop", async () => {
		// Given a timer armed before a command that outlives it
		const order: string[] = [];
		const timer = new Promise<void>((resolveTimer) => {
			setTimeout(() => {
				order.push("timer");
				resolveTimer();
			}, 0);
		});
		// When the command is resolved
		const value = await resolveConfigValue("!sh -c 'sleep 0.3; echo slow-key'");
		order.push("command");
		await timer;
		// Then the loop ran the timer while the shell was still working
		expect(value).toBe("slow-key");
		expect(order).toEqual(["timer", "command"]);
	});

	test.each(["!exit 1", "!nonexistent-command-12345", "!printf ''"])(
		"returns undefined when command resolution fails: %s",
		async (command) => {
			expect(await resolveConfigValue(command)).toBeUndefined();
		},
	);

	test("caches successful and failed commands until explicitly cleared", async () => {
		const counterFile = join(tempDir, "counter");
		writeFileSync(counterFile, "0");
		const escapedPath = counterFile.replace(/\\/g, "/").replace(/"/g, '\\"');
		const success = `!sh -c 'count=$(cat "${escapedPath}"); echo $((count + 1)) > "${escapedPath}"; echo value'`;

		expect(await resolveConfigValue(success)).toBe("value");
		expect(await resolveConfigValue(success)).toBe("value");
		expect(readFileSync(counterFile, "utf-8").trim()).toBe("1");

		clearConfigValueCache();
		expect(await resolveConfigValue(success)).toBe("value");
		expect(readFileSync(counterFile, "utf-8").trim()).toBe("2");

		// A failed resolution retries the command (3 attempts) before caching the
		// failure; the second resolve hits the cache without executing again.
		const failure = `!sh -c 'count=$(cat "${escapedPath}"); echo $((count + 1)) > "${escapedPath}"; exit 1'`;
		expect(await resolveConfigValue(failure)).toBeUndefined();
		expect(await resolveConfigValue(failure)).toBeUndefined();
		expect(readFileSync(counterFile, "utf-8").trim()).toBe("5");
	});

	test("shares one execution between concurrent resolutions of the same command", async () => {
		// Given a command that records every execution
		const counterFile = join(tempDir, "concurrent-counter");
		writeFileSync(counterFile, "0");
		const escapedPath = counterFile.replace(/\\/g, "/").replace(/"/g, '\\"');
		const command = `!sh -c 'count=$(cat "${escapedPath}"); echo $((count + 1)) > "${escapedPath}"; echo value'`;
		// When two callers resolve it at the same time
		const [first, second] = await Promise.all([resolveConfigValue(command), resolveConfigValue(command)]);
		// Then both get the value from a single execution
		expect([first, second]).toEqual(["value", "value"]);
		expect(readFileSync(counterFile, "utf-8").trim()).toBe("1");
	});

	test("does not cache environment values", async () => {
		process.env.TEST_CONFIG_DYNAMIC = "first";
		try {
			expect(await resolveConfigValue("$TEST_CONFIG_DYNAMIC")).toBe("first");
			process.env.TEST_CONFIG_DYNAMIC = "second";
			expect(await resolveConfigValue("$TEST_CONFIG_DYNAMIC")).toBe("second");
		} finally {
			delete process.env.TEST_CONFIG_DYNAMIC;
		}
	});

	test("uncached resolution executes a command on every call", async () => {
		const counterFile = join(tempDir, "uncached-counter");
		writeFileSync(counterFile, "0");
		const escapedPath = counterFile.replace(/\\/g, "/").replace(/"/g, '\\"');
		const command = `!sh -c 'count=$(cat "${escapedPath}"); echo $((count + 1)) > "${escapedPath}"; echo value'`;
		expect(await resolveConfigValueUncached(command)).toBe("value");
		expect(await resolveConfigValueUncached(command)).toBe("value");
		expect(readFileSync(counterFile, "utf-8").trim()).toBe("2");
	});

	test("retries a transiently failing command until it succeeds", async () => {
		const counterFile = join(tempDir, "retry-counter");
		writeFileSync(counterFile, "0");
		const escapedPath = counterFile.replace(/\\/g, "/").replace(/"/g, '\\"');
		// Fails while the counter is below 3: attempts 1-2 fail, attempt 3 succeeds.
		const command = `!sh -c 'count=$(cat "${escapedPath}"); count=$((count + 1)); echo $count > "${escapedPath}"; [ $count -lt 3 ] && exit 1; echo value'`;
		expect(await resolveConfigValueUncached(command)).toBe("value");
		expect(readFileSync(counterFile, "utf-8").trim()).toBe("3");
	});

	test("gives up retrying after a bounded number of attempts", async () => {
		const counterFile = join(tempDir, "giveup-counter");
		writeFileSync(counterFile, "0");
		const escapedPath = counterFile.replace(/\\/g, "/").replace(/"/g, '\\"');
		const command = `!sh -c 'count=$(cat "${escapedPath}"); echo $((count + 1)) > "${escapedPath}"; exit 1'`;
		expect(await resolveConfigValueUncached(command)).toBeUndefined();
		expect(readFileSync(counterFile, "utf-8").trim()).toBe("3");
	});

	test("uses stdin when the configured Windows shell requires it", async () => {
		if (process.platform === "win32") return;
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		vi.spyOn(shellModule, "getShellConfig").mockReturnValue({
			shell: "/bin/bash",
			args: ["-s"],
			commandTransport: "stdin",
		});
		try {
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			const expansion = "$" + "{name}";
			expect(await resolveConfigValueUncached(`!name='World'; echo "Hello, ${expansion}!"`)).toBe("Hello, World!");
		} finally {
			if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
		}
	});
});
