import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startClaudeCliLogin } from "../src/core/extensions/builtin/anthropic-subscription/claude-cli-auth.ts";
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

describe.runIf(process.platform === "win32" && process.env.CI === "true")(
	"bundled claude BROWSER=<.cmd> (Windows)",
	() => {
		it("hands the one-click URL to a .cmd browser helper and prints the copy-code URL", async () => {
			const root = mkdtempSync(join(tmpdir(), "senpi-claude-cli-win-"));
			roots.push(root);
			const controller = new AbortController();
			let manualUrl: string | undefined;
			const automaticUrl = new Promise<string>((resolve) => {
				const login = startClaudeCliLogin({
					executable: resolveClaudeCodeExecutable(defaultExecutableDeps()),
					configDir: join(root, "account"),
					parentEnv: { ...process.env, HOME: root, USERPROFILE: root },
					method: "browser",
					signal: controller.signal,
					onManualUrl: (url) => {
						manualUrl = url;
					},
					onAutomaticUrl: resolve,
				});
				void login.result.then((result) => resolve(`login ended first: ${result.outcome}`));
			});

			try {
				expect(await automaticUrl).toMatch(/^https:\/\/\S+redirect_uri=http%3A%2F%2Flocalhost%3A\d+%2Fcallback/);
				expect(manualUrl).toMatch(/^https:\/\/\S+/);
			} finally {
				controller.abort();
			}
		}, 60_000);
	},
);
