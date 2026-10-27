import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ClaudeCliLoginOptions,
	normalizePastedCode,
	startClaudeCliLogin,
} from "../src/core/extensions/builtin/anthropic-subscription/claude-cli-auth.ts";

// The fixture replays the 2.1.306 `claude auth login --claudeai` stdout lines, `$BROWSER` call and exit codes.
const FIXTURE = join(import.meta.dirname, "fixtures", "claude-cli-auth", "fake-claude.mjs");
const roots: string[] = [];

afterEach(() => {
	vi.useRealTimers();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Recorded = { pid?: number; argv?: string[]; configDir?: string; stdin?: string };

function setup(mode: string) {
	const root = mkdtempSync(join(tmpdir(), "senpi-claude-cli-login-"));
	roots.push(root);
	const executable = join(root, "claude");
	copyFileSync(FIXTURE, executable);
	chmodSync(executable, 0o755);
	const recordPath = join(root, "record.jsonl");
	const configDir = join(root, "account");
	const parentEnv: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: root,
		FAKE_CLAUDE_MODE: mode,
		FAKE_CLAUDE_RECORD: recordPath,
	};
	const records = (): Recorded[] =>
		readFileSync(recordPath, "utf8")
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as Recorded);
	const options = (overrides: Partial<ClaudeCliLoginOptions> = {}): ClaudeCliLoginOptions => ({
		executable,
		configDir,
		method: "browser",
		parentEnv,
		...overrides,
	});
	return { options, records, configDir };
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("claude auth login through the CLI (fixture 2.1.306 shapes)", () => {
	it("captures the one-click URL through BROWSER and the copy-code URL from stdout", async () => {
		const { options } = setup("login-auto");
		const automatic: string[] = [];
		const manual: string[] = [];

		const login = startClaudeCliLogin(
			options({ onAutomaticUrl: (url) => automatic.push(url), onManualUrl: (url) => manual.push(url) }),
		);

		expect(await login.result).toEqual({ outcome: "success" });
		expect(automatic).toEqual([expect.stringContaining("redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback")]);
		expect(manual).toEqual([expect.stringContaining("platform.claude.com%2Foauth%2Fcode%2Fcallback")]);
	});

	it("writes a pasted code to stdin as code#state and never to argv", async () => {
		const { options, records, configDir } = setup("login-paste");
		const login = startClaudeCliLogin(
			options({
				onManualUrl: () => {
					expect(login.submitCode("https://platform.claude.com/oauth/code/callback?code=abc123&state=st456")).toBe(
						true,
					);
				},
			}),
		);

		expect(await login.result).toEqual({ outcome: "success" });
		const [start, pasted] = records();
		expect(start?.argv).toEqual(["auth", "login", "--claudeai"]);
		expect(start?.argv?.join(" ")).not.toContain("abc123");
		expect(start?.configDir).toBe(configDir);
		expect(pasted?.stdin).toBe("abc123#st456");
	});

	it("does not report success for an exit 0 without the success line", async () => {
		const { options } = setup("login-exit0-silent");
		const login = startClaudeCliLogin(options({ onManualUrl: () => login.submitCode("code#state") }));

		expect(await login.result).toEqual({ outcome: "failed", reason: "unexpected_exit" });
	});

	it("maps an org refusal to a typed reason", async () => {
		const { options } = setup("login-org-denied");

		expect(await startClaudeCliLogin(options()).result).toEqual({ outcome: "failed", reason: "org_not_allowed" });
	});

	it("copy-code login discards the one-click URL", async () => {
		const { options } = setup("login-auto");
		const automatic: string[] = [];

		const login = startClaudeCliLogin(options({ method: "copy-code", onAutomaticUrl: (url) => automatic.push(url) }));

		expect(await login.result).toEqual({ outcome: "success" });
		expect(automatic).toEqual([]);
	});

	// The fixture ignores SIGTERM, so only the SIGKILL after the grace period can end it. Timers are faked and
	// advanced once the CLI has printed its URL, so the kill never races the child's startup.
	it("cancel kills the child, escalating to SIGKILL when SIGTERM is ignored", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { options, records } = setup("login-hang");
		const controller = new AbortController();

		const login = startClaudeCliLogin(
			options({
				signal: controller.signal,
				onManualUrl: () => {
					controller.abort();
					vi.advanceTimersByTime(5_000);
				},
			}),
		);

		expect(await login.result).toEqual({ outcome: "cancelled" });
		const pid = records()[0]?.pid ?? 0;
		expect(pid).toBeGreaterThan(0);
		expect(isAlive(pid)).toBe(false);
	});

	it("the idle timeout kills the child", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { options, records } = setup("login-hang");

		const login = startClaudeCliLogin(options({ onManualUrl: () => vi.advanceTimersByTime(10 * 60 * 1000 + 5_000) }));

		expect(await login.result).toEqual({ outcome: "timeout" });
		expect(isAlive(records()[0]?.pid ?? 0)).toBe(false);
	});
});

describe("normalizePastedCode", () => {
	it.each([
		["abc#def", "abc#def"],
		["  abc  ", "abc"],
		["https://platform.claude.com/oauth/code/callback?code=abc&state=def", "abc#def"],
		["code=abc&state=def", "abc#def"],
		["", undefined],
		["abc\ndef", undefined],
	])("%j -> %j", (input, expected) => {
		expect(normalizePastedCode(input)).toBe(expected);
	});
});
