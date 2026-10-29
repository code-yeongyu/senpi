import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readClaudeCliAuthStatus } from "../src/core/extensions/builtin/anthropic-subscription/claude-cli-auth-status.ts";
import { runClaudeCliToExit } from "../src/core/extensions/builtin/anthropic-subscription/claude-cli-process.ts";
import {
	defaultExecutableDeps,
	resolveClaudeCodeExecutable,
} from "../src/core/extensions/builtin/anthropic-subscription/executable.ts";

// The bundled binary, not the fixture: guards the `auth status --json` shape the parser pins. CI-only on Linux,
// where the runner has no Claude login; a developer machine never runs the real CLI against its own account.
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.runIf(process.platform === "linux" && process.env.CI === "true")(
	"bundled claude auth status (real binary)",
	() => {
		it("prints loggedIn: false and exits 1 in an empty config dir", async () => {
			const root = mkdtempSync(join(tmpdir(), "senpi-claude-cli-real-"));
			roots.push(root);
			const configDir = join(root, "account");
			mkdirSync(configDir);
			const run = {
				executable: resolveClaudeCodeExecutable(defaultExecutableDeps()),
				configDir,
				parentEnv: { PATH: process.env.PATH, HOME: root },
			};

			const exit = await runClaudeCliToExit(run, ["auth", "status", "--json"], 30_000);

			expect(exit?.exitCode).toBe(1);
			expect(JSON.parse(exit?.stdout ?? "")).toMatchObject({ loggedIn: false });
			expect(await readClaudeCliAuthStatus(run, 30_000)).toEqual({ state: "signed_out" });
		}, 60_000);
	},
);
