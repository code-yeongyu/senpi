/**
 * senpi#7002: a TUI-mode login test that does not inject the `openBrowser` dep hands the login URL
 * to the real platform browser through `createExtensionLoginInteraction`'s default launcher
 * (`utils/open-browser.ts` spawns `open`/`xdg-open` by name). The suite's setup shadows both names
 * with a recording no-op, so the default launcher cannot leave a test process. This regression
 * drives the un-injected production path end to end: the URL must land in the guard's record file.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { createExtensionLoginInteraction } from "../../../src/core/extensions/builtin/oauth-login-interaction.ts";
import { createAccountCommandContext } from "../account-command-harness.ts";

const GUARD_URL = "https://claude.ai/oauth/authorize?code=true&client_id=guard-probe&state=7002";

async function recordedUrls(record: string, probe: string, deadlineMs = 5_000): Promise<string[]> {
	const deadline = Date.now() + deadlineMs;
	for (;;) {
		if (existsSync(record)) {
			const lines = readFileSync(record, "utf8").split("\n").filter(Boolean);
			if (lines.some((line) => line.includes(probe))) return lines;
		}
		if (Date.now() > deadline) return [];
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe("suite browser-opener guard (senpi#7002)", () => {
	it("a TUI auth_url with no injected launcher is recorded by the guard, never opened", async () => {
		const record = process.env.SENPI_TEST_BROWSER_GUARD_RECORD;
		if (record === undefined) {
			throw new Error(
				"SENPI_TEST_BROWSER_GUARD_RECORD is missing: the test setup no longer installs the browser-opener guard",
			);
		}
		const { ctx } = createAccountCommandContext(AuthStorage.inMemory(), "/tmp");
		const interaction = createExtensionLoginInteraction(ctx, { providerLabel: "Guard probe" });

		interaction.notify({ type: "auth_url", url: GUARD_URL });

		const lines = await recordedUrls(record, "client_id=guard-probe");
		expect(lines).toContain(GUARD_URL);
	});
});
