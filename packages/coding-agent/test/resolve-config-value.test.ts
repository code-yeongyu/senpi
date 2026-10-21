import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeTempDir } from "../../../scripts/vitest-temp.ts";
import {
	clearConfigValueCache,
	getConfigValueEnvVarNames,
	resolveConfigValue,
	resolveConfigValueOrThrow,
	resolveConfigValueUncached,
	resolveHeadersOrThrow,
} from "../src/core/resolve-config-value.ts";
import * as shellModule from "../src/utils/shell.ts";
import { writeSecretFile } from "./mcp/config-test-helpers.ts";

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

	test.skipIf(process.platform === "win32")("uses stdin when the configured Windows shell requires it", async () => {
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

/**
 * `{file:<path>}` is the credential-reference form: the config names the file
 * and the engine reads it at load time, so the secret keeps exactly one home on
 * disk and stays fresh when it is rotated. Every refusal here names the path
 * and the reason, because "your credential is broken" is not actionable.
 */
describe("resolveConfigValue {file:...} references", () => {
	let tempDir: string;

	function writeSecret(contents: string): string {
		return writeSecretFile(tempDir, contents);
	}

	function escaped(value: string): string {
		return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}

	beforeEach(() => {
		tempDir = makeTempDir(join(tmpdir(), "pi-config-file-ref-"));
		clearConfigValueCache();
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		clearConfigValueCache();
		vi.restoreAllMocks();
	});

	test("reads the file and strips only its trailing whitespace", async () => {
		// Given a credential file written with the conventional trailing newline
		// and interior whitespace that is part of the secret
		const path = writeSecret("sk-live-abc\n  def  \n\n\t\n");
		// Then the secret is the trimmed body; interior whitespace is content and
		// the trailing-newline convention never leaks in
		expect(await resolveConfigValue(`{file:${path}}`)).toBe("sk-live-abc\n  def");
		// A single trailing newline (the common credential-file shape) disappears
		expect(await resolveConfigValue(`{file:${writeSecret("just-a-token\n")}}`)).toBe("just-a-token");
	});

	test("reads the file fresh on every resolution so a rotated credential takes effect", async () => {
		const path = writeSecret("first");
		expect(await resolveConfigValue(`{file:${path}}`)).toBe("first");
		// A rotated credential is picked up without clearing the command cache
		writeFileSync(path, "second");
		expect(await resolveConfigValue(`{file:${path}}`)).toBe("second");
	});

	test("expands a ~ prefix against HOME before checking absoluteness", async () => {
		// Given a credential file nested under a temporary HOME
		const home = join(tempDir, "home");
		mkdirSync(join(home, ".config", "senpi"), { recursive: true });
		writeFileSync(join(home, "token"), "from-home\n");
		writeFileSync(join(home, ".config", "senpi", "token"), "from-nested-home\n");
		const previousHome = process.env.HOME;
		process.env.HOME = home;
		try {
			expect(await resolveConfigValue("{file:~/token}")).toBe("from-home");
			expect(await resolveConfigValue("{file:~/.config/senpi/token}")).toBe("from-nested-home");
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
		}
	});

	test("expands ~ only as a home prefix, never as a named user", async () => {
		// `~otheruser/x` is not `$HOME`-relative and must not be guessed at
		await expect(resolveConfigValue("{file:~otheruser/token}")).rejects.toThrow(/absolute path required/i);
	});

	test(`interpolates $${"{NAME}"} and {file:...} together in either order`, async () => {
		process.env.TEST_CONFIG_PREFIX = "Bearer";
		try {
			const path = writeSecret("s3cr3t\n");
			expect(await resolveConfigValue(`${"$"}{TEST_CONFIG_PREFIX} ${"$"}{TEST_CONFIG_PREFIX}`)).toBe(
				"Bearer Bearer",
			);
			expect(await resolveConfigValue(`${"$"}{TEST_CONFIG_PREFIX} {file:${path}}`)).toBe("Bearer s3cr3t");
			expect(await resolveConfigValue(`{file:${path}}/${"$"}{TEST_CONFIG_PREFIX}`)).toBe("s3cr3t/Bearer");
		} finally {
			delete process.env.TEST_CONFIG_PREFIX;
		}
	});

	test("never re-scans a resolved file body for placeholders", async () => {
		// Given a secret whose bytes look like both placeholder forms
		const path = writeSecret(`${"$"}{TEST_CONFIG_INJECTED} {file:/should/not/be/read}\n`);
		process.env.TEST_CONFIG_INJECTED = "leaked";
		try {
			// Then the body is inserted verbatim; a config file cannot inject a second lookup
			expect(await resolveConfigValue(`{file:${path}}`)).toBe(
				`${"$"}{TEST_CONFIG_INJECTED} {file:/should/not/be/read}`,
			);
		} finally {
			delete process.env.TEST_CONFIG_INJECTED;
		}
	});

	test("never reads a file for a value that is a shell command", async () => {
		// `!` dispatch is decided by the reference form, so a config whose text merely
		// mentions a path cannot smuggle a read in ahead of the command branch.
		const path = writeSecret("should-stay-unread");
		expect(await resolveConfigValue("!echo literal")).toBe("literal");
		// A `!` value runs as a command and never consults the {file:...} form at all.
		expect(await resolveConfigValue(`!cat ${path}`)).toBe("should-stay-unread");
	});

	test("fails closed when the file does not exist, naming the path", async () => {
		const missing = join(tempDir, "absent-token");
		await expect(resolveConfigValue(`{file:${missing}}`)).rejects.toThrow(
			new RegExp(`file does not exist: ${escaped(missing)}`),
		);
		await expect(resolveConfigValue(`{file:${missing}}`)).rejects.toThrow(/failed to resolve \{file:/i);
	});

	test("fails closed when the file is empty, naming the path", async () => {
		const empty = writeSecret("");
		await expect(resolveConfigValue(`{file:${empty}}`)).rejects.toThrow(
			new RegExp(`file is empty: ${escaped(empty)}`),
		);
		// A file holding only whitespace is empty once the trailing strip runs
		const blank = writeSecret("\n \t\n");
		await expect(resolveConfigValue(`{file:${blank}}`)).rejects.toThrow(/file is empty/i);
	});

	test("fails closed on a relative path, naming the path and saying absolute", async () => {
		await expect(resolveConfigValue("{file:./token}")).rejects.toThrow("absolute path required, got ./token");
		await expect(resolveConfigValue("{file:token}")).rejects.toThrow("absolute path required, got token");
	});

	test("checks the path shape before touching the filesystem", async () => {
		// Given a relative reference that ALSO does not exist. Then the shape error
		// wins outright: the whole message is the absolute-path complaint, so it
		// cannot also be reporting a missing file.
		await expect(resolveConfigValue("{file:definitely-not-here}")).rejects.toThrow(
			/^Failed to resolve \{file:definitely-not-here\}: absolute path required, got definitely-not-here$/,
		);
	});

	test("refuses every read error rather than falling back to a literal", async () => {
		// Given a directory: a read error that is not ENOENT
		const directory = join(tempDir, "not-a-file");
		mkdirSync(directory, { recursive: true });
		await expect(resolveConfigValue(`{file:${directory}}`)).rejects.toThrow(`not a readable file: ${directory}`);
	});

	test.skipIf(process.getuid?.() === 0)("refuses an unreadable file, naming the path and the reason", async () => {
		const locked = writeSecret("unreachable-secret");
		chmodSync(locked, 0o000);
		try {
			await expect(resolveConfigValue(`{file:${locked}}`)).rejects.toThrow(
				new RegExp(`permission denied: ${escaped(locked)}`),
			);
		} finally {
			chmodSync(locked, 0o600);
		}
	});

	test("does not add a permission-mode policy to a readable world-readable file", async () => {
		// The documented decision is to trust the user's reference and fail only on a
		// read error, so a 0644 secret resolves rather than being refused for mode.
		const shared = writeSecret("world-readable-secret");
		chmodSync(shared, 0o644);
		expect(await resolveConfigValue(`{file:${shared}}`)).toBe("world-readable-secret");
	});

	test("follows a symlink instead of reshaping the user's trust model", async () => {
		const target = writeSecret("behind-the-link");
		const link = join(tempDir, "link-token");
		symlinkSync(target, link);
		expect(await resolveConfigValue(`{file:${link}}`)).toBe("behind-the-link");
	});

	test("names the failing reference and the reason through the throwing resolvers", async () => {
		const missing = join(tempDir, "absent");
		await expect(resolveConfigValueOrThrow(`{file:${missing}}`, 'API key for provider "demo"')).rejects.toThrow(
			`Failed to resolve API key for provider "demo" from {file:${missing}}: file does not exist: ${missing}`,
		);
		await expect(
			resolveHeadersOrThrow({ Authorization: `Bearer {file:${missing}}` }, "demo provider"),
		).rejects.toThrow('demo provider header "Authorization" from {file:');
	});

	test("keeps a file reference out of the reported environment-variable names", async () => {
		const path = writeSecret("x");
		expect(getConfigValueEnvVarNames(`{file:${path}}${"$"}{TEST_CONFIG_MIXED}`)).toEqual(["TEST_CONFIG_MIXED"]);
		expect(getConfigValueEnvVarNames(`{file:${path}}`)).toEqual([]);
	});
});
