import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CursorCliAccountSlot } from "../../src/core/extensions/builtin/cursor-cli-oauth/accounts.ts";
import { runInCursorAccountHome } from "../../src/core/extensions/builtin/cursor-cli-oauth/home-store.ts";

const temporaryDirectories: string[] = [];

function temporaryAgentDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "senpi-cursor-home-store-"));
	temporaryDirectories.push(directory);
	return directory;
}

function account(overrides: Partial<CursorCliAccountSlot> = {}): CursorCliAccountSlot {
	return {
		name: "work",
		access: "access-token-secret",
		refresh: "refresh-token-secret",
		expires: 4_102_444_800_000,
		source: "login",
		...overrides,
	};
}

function mode(path: string): number {
	return statSync(path).mode & 0o777;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("Cursor CLI OAuth per-account HOME store", () => {
	it("creates a private directory tree and writes the file-store credential at mode 0600", async () => {
		const agentDir = temporaryAgentDirectory();
		const slot = account();

		const completed = await runInCursorAccountHome(agentDir, slot, async ({ home, authPath }) => {
			expect(home).toBe(join(agentDir, "cursor-cli-oauth", "accounts", slot.name, "home"));
			expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({
				accessToken: slot.access,
				refreshToken: slot.refresh,
				apiKey: null,
				bedrockCredentials: null,
			});
			expect(mode(authPath)).toBe(0o600);
			for (const directory of [
				join(agentDir, "cursor-cli-oauth"),
				join(agentDir, "cursor-cli-oauth", "accounts"),
				join(agentDir, "cursor-cli-oauth", "accounts", slot.name),
				home,
				join(home, ".cursor"),
			]) {
				expect(mode(directory)).toBe(0o700);
			}
			return "spawned";
		});

		expect(completed.result).toBe("spawned");
		expect(completed.slot).toEqual(slot);
	});

	it.each(["../escape", "..", "nested/slot", "-leading"])(
		"rejects malformed slot name %j before creating the accounts tree",
		async (name) => {
			const agentDir = temporaryAgentDirectory();
			const accountsRoot = join(agentDir, "cursor-cli-oauth", "accounts");
			let callbackCalled = false;

			await expect(
				runInCursorAccountHome(agentDir, account({ name }), async () => {
					callbackCalled = true;
				}),
			).rejects.toThrowError(/invalid account name/i);

			expect(callbackCalled).toBe(false);
			expect(existsSync(accountsRoot)).toBe(false);
		},
	);

	it("keeps the HOME durable across runs while reapplying auth before every spawn", async () => {
		const agentDir = temporaryAgentDirectory();
		const original = account();
		let cliConfigPath = "";

		const first = await runInCursorAccountHome(agentDir, original, async ({ authPath, home }) => {
			cliConfigPath = join(home, ".cursor", "cli-config.json");
			writeFileSync(cliConfigPath, '{"permissions":{"allow":["first-cli-rewrite"]}}');
			writeFileSync(
				authPath,
				JSON.stringify({
					accessToken: original.access,
					refreshToken: "rotated-refresh-token-one",
					apiKey: null,
					bedrockCredentials: null,
				}),
			);
		});

		const second = await runInCursorAccountHome(agentDir, first.slot, async ({ authPath }) => {
			expect(readFileSync(cliConfigPath, "utf8")).toContain("first-cli-rewrite");
			expect(JSON.parse(readFileSync(authPath, "utf8"))).toMatchObject({
				accessToken: original.access,
				refreshToken: "rotated-refresh-token-one",
			});
			writeFileSync(cliConfigPath, '{"permissions":{"allow":["second-cli-rewrite"]}}');
			writeFileSync(
				authPath,
				JSON.stringify({
					accessToken: original.access,
					refreshToken: "rotated-refresh-token-two",
					apiKey: null,
					bedrockCredentials: null,
				}),
			);
		});

		expect(first.slot.refresh).toBe("rotated-refresh-token-one");
		expect(second.slot.refresh).toBe("rotated-refresh-token-two");
		expect(readFileSync(cliConfigPath, "utf8")).toContain("second-cli-rewrite");
	});

	it("rejects a malformed CLI credential instead of treating file existence as refresh success", async () => {
		const agentDir = temporaryAgentDirectory();

		await expect(
			runInCursorAccountHome(agentDir, account(), async ({ authPath }) => {
				writeFileSync(authPath, JSON.stringify({ refreshToken: { token: "misleading" } }));
			}),
		).rejects.toThrowError(/invalid cursor credential/i);
	});

	it("logs only token byte lengths and never emits token material", async () => {
		const agentDir = temporaryAgentDirectory();
		const slot = account();
		const rotated = "rotated-refresh-token-secret";
		const lines: string[] = [];

		await runInCursorAccountHome(
			agentDir,
			slot,
			async ({ authPath }) => {
				writeFileSync(
					authPath,
					JSON.stringify({
						accessToken: slot.access,
						refreshToken: rotated,
						apiKey: null,
						bedrockCredentials: null,
					}),
				);
			},
			(line) => lines.push(line),
		);

		const output = lines.join("\n");
		expect(lines.length).toBeGreaterThan(0);
		expect(output).toContain(Buffer.byteLength(slot.access, "utf8").toString());
		expect(output).toContain(Buffer.byteLength(rotated, "utf8").toString());
		for (const token of [slot.access, slot.refresh, rotated]) {
			expect(output).not.toContain(token);
		}
	});
});
