import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ClaudeCliLoginResult,
	startClaudeCliLogin,
} from "../src/core/extensions/builtin/anthropic-subscription/claude-cli-auth.ts";
import {
	defaultExecutableDeps,
	resolveClaudeCodeExecutable,
} from "../src/core/extensions/builtin/anthropic-subscription/executable.ts";

// Decides the Windows default sign-in method: whether the bundled CLI runs a `.cmd` helper given as BROWSER. If this
// fails, Windows defaults to copy-code login. CI-only on windows-latest; it starts a login in an empty config dir
// and cancels it once the URLs arrive, so no account is involved.
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The login's 5 s SIGTERM-to-SIGKILL grace, plus room for a loaded runner. */
const STOP_DEADLINE_MS = 15_000;

/**
 * Cancels the login and waits for the claude child's `close`. The child runs with its cwd and config dir inside the
 * case's root, and Windows refuses to delete a directory a live process holds (senpi#4654), so the root is removed
 * only after this resolves.
 */
async function stopLogin(
	controller: AbortController,
	result: Promise<ClaudeCliLoginResult>,
	executable: string,
): Promise<void> {
	controller.abort();
	let deadline: ReturnType<typeof setTimeout> | undefined;
	const stillRunning = new Promise<never>((_, reject) => {
		deadline = setTimeout(
			() =>
				reject(
					new Error(
						`claude auth login (${executable}) is still running ${STOP_DEADLINE_MS} ms after abort; its temp root stays in use`,
					),
				),
			STOP_DEADLINE_MS,
		);
	});
	try {
		await Promise.race([result, stillRunning]);
	} finally {
		clearTimeout(deadline);
	}
}

describe.runIf(process.platform === "win32" && process.env.CI === "true")(
	"bundled claude BROWSER=<.cmd> (Windows)",
	() => {
		it("hands the one-click URL to a .cmd browser helper and prints the copy-code URL", async () => {
			const root = mkdtempSync(join(tmpdir(), "senpi-claude-cli-win-"));
			roots.push(root);
			const executable = resolveClaudeCodeExecutable(defaultExecutableDeps());
			const controller = new AbortController();
			let manualUrl: string | undefined;
			let onAutomaticUrl: (url: string) => void = () => {};
			const automaticUrl = new Promise<string>((resolve) => {
				onAutomaticUrl = resolve;
			});
			const login = startClaudeCliLogin({
				executable,
				configDir: join(root, "account"),
				parentEnv: { ...process.env, HOME: root, USERPROFILE: root },
				method: "browser",
				signal: controller.signal,
				onManualUrl: (url) => {
					manualUrl = url;
				},
				onAutomaticUrl,
			});
			void login.result.then((result) => onAutomaticUrl(`login ended first: ${result.outcome}`));

			try {
				expect(await automaticUrl).toMatch(/^https:\/\/\S+redirect_uri=http%3A%2F%2Flocalhost%3A\d+%2Fcallback/);
				expect(manualUrl).toMatch(/^https:\/\/\S+/);
			} finally {
				await stopLogin(controller, login.result, executable);
			}
		}, 60_000);
	},
);
