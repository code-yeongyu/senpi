import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	rmSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startClaudeCliLogin } from "../../../src/core/extensions/builtin/anthropic-subscription/claude-cli-auth.ts";
import { createClaudeCliBrowserCapture } from "../../../src/core/extensions/builtin/anthropic-subscription/claude-cli-browser-capture.ts";

const { debugLog } = vi.hoisted(() => ({ debugLog: vi.fn() }));
vi.mock("../../../src/core/session-log.ts", () => ({
	createSessionLogger: () => ({ debug: debugLog }),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, renameSync: vi.fn(actual.renameSync), rmSync: vi.fn(actual.rmSync) };
});

const roots: string[] = [];
const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");

afterEach(() => {
	debugLog.mockClear();
	vi.mocked(rmSync).mockImplementation(realFs.rmSync);
	vi.mocked(renameSync).mockImplementation(realFs.renameSync);
	for (const root of roots.splice(0)) {
		realFs.rmSync(root, { recursive: true, force: true });
		realFs.rmSync(`${root}-disposed`, { recursive: true, force: true });
	}
});

it("revokes the browser sink before removal can race a late helper write (#4701)", () => {
	const capture = createClaudeCliBrowserCapture("capture", vi.fn());
	const dir = dirname(capture.helperPath);
	roots.push(dir);
	// The CLI may die during spawnSync(BROWSER). Its helper has already loaded this script,
	// has independent stdio, and can execute the redirection after the CLI's close event.
	const replayDir = mkdtempSync(join(tmpdir(), "senpi-late-browser-"));
	roots.push(replayDir);
	const replay = join(replayDir, process.platform === "win32" ? "browser.cmd" : "browser");
	copyFileSync(capture.helperPath, replay);
	chmodSync(replay, 0o700);
	const timeline: string[] = [];
	let writerStatus: number | null = null;
	let sinkExists: boolean | undefined;
	vi.mocked(rmSync).mockImplementationOnce((path) => {
		const target = String(path);
		const entries = readdirSync(target);
		timeline.push(`snapshot entries=${entries.join(",")}`);
		const writer =
			process.platform === "win32"
				? spawnSync("cmd.exe", ["/d", "/c", replay, "https://example.test/login"], { encoding: "utf8" })
				: spawnSync(replay, ["https://example.test/login"], { encoding: "utf8" });
		timeline.push(`late-browser status=${writer.status} sinkExists=${existsSync(join(dir, "urls"))}`);
		writerStatus = writer.status;
		sinkExists = existsSync(join(dir, "urls"));
		for (const entry of entries) unlinkSync(join(target, entry));
		try {
			rmdirSync(target);
		} catch (error) {
			timeline.push(`rmdir code=${(error as NodeJS.ErrnoException).code}`);
			throw error;
		}
	});

	let failure: unknown;
	try {
		capture.dispose();
	} catch (error) {
		failure = error;
	}
	expect(failure, timeline.join(" -> ")).toBeUndefined();
	expect(writerStatus, timeline.join(" -> ")).not.toBeNull();
	expect(writerStatus, timeline.join(" -> ")).not.toBe(0);
	expect(sinkExists, timeline.join(" -> ")).toBe(false);
	expect(existsSync(dir)).toBe(false);
	expect(existsSync(`${dir}-disposed`)).toBe(false);
});

it.each(["EBUSY", "EPERM"])("removes the original capture directory when rename fails with %s", (code) => {
	const capture = createClaudeCliBrowserCapture("capture", vi.fn());
	const dir = dirname(capture.helperPath);
	roots.push(dir);
	writeFileSync(join(dir, "urls"), "https://example.test/private-login\n");
	vi.mocked(renameSync).mockImplementationOnce(() => {
		throw Object.assign(new Error(code), { code });
	});

	capture.dispose();

	expect(existsSync(dir)).toBe(false);
	expect(existsSync(`${dir}-disposed`)).toBe(false);
	expect(debugLog).toHaveBeenCalledWith("claude_cli_browser_capture_rename_failed", { source: dir });
});

it("a private-directory cleanup error cannot discard a cancelled login outcome (#4701)", async () => {
	vi.mocked(rmSync).mockImplementationOnce((path) => {
		const dir = String(path);
		roots.push(dir);
		// A real nonempty-directory error, not a fabricated error object.
		rmdirSync(dir);
	});
	const signal = AbortSignal.abort();
	const login = startClaudeCliLogin({
		executable: "unused",
		configDir: "unused",
		method: "browser",
		signal,
	});

	expect(await login.result).toEqual({ outcome: "cancelled" });
	expect(debugLog).toHaveBeenCalledWith("claude_cli_browser_capture_cleanup_failed", {
		source: roots.at(-1),
	});
});
