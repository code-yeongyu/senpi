/**
 * senpi#5627: the claude CLI credential file is checked, then read. A link swapped in between the two steps must
 * not be followed: the read opens the file without following a final link and checks that the handle it opened is
 * the file it checked. The swap is made deterministic by doing it inside the check itself. Tokens are dummy strings.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const swap = vi.hoisted(() => ({ target: undefined as string | undefined, outside: undefined as string | undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const { symlinkSync: link, unlinkSync: unlink } = await import("node:fs");
	return {
		...actual,
		lstat: async (...args: Parameters<typeof actual.lstat>) => {
			const stats = await actual.lstat(...args);
			if (swap.target !== undefined && swap.outside !== undefined && String(args[0]) === swap.target) {
				unlink(swap.target);
				link(swap.outside, swap.target);
				swap.target = undefined;
			}
			return stats;
		},
	};
});

const { readClaudeCliAccessToken } =
	await import("../../../src/core/extensions/builtin/anthropic-subscription/claude-cli-account-dir.ts");

const NOW = 1_800_000_000_000;
const roots: string[] = [];
afterEach(() => {
	swap.target = undefined;
	swap.outside = undefined;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function credentials(token: string): string {
	return JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: NOW + 3_600_000 } });
}

describe("reading the claude CLI credential file", () => {
	it("refuses a credential file swapped for a link after it was checked", async () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-5627-nofollow-"));
		roots.push(root);
		const accountDir = join(root, "account");
		mkdirSync(accountDir);
		const file = join(accountDir, ".credentials.json");
		writeFileSync(file, credentials("dummy-account-token"));
		const outside = join(root, "outside.json");
		writeFileSync(outside, credentials("dummy-outside-token"));
		swap.target = file;
		swap.outside = outside;

		expect(await readClaudeCliAccessToken(accountDir, NOW)).toBeUndefined();
	});

	it("still reads an ordinary credential file", async () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-5627-nofollow-"));
		roots.push(root);
		const accountDir = join(root, "account");
		mkdirSync(accountDir);
		writeFileSync(join(accountDir, ".credentials.json"), credentials("dummy-account-token"));

		expect(await readClaudeCliAccessToken(accountDir, NOW)).toBe("dummy-account-token");
	});
});
