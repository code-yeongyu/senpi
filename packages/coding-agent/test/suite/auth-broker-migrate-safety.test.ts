import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeAuthBrokerCommand } from "../../src/cli/auth-broker-cli.ts";

function authJson(dir: string): string {
	const path = join(dir, "auth.json");
	writeFileSync(path, JSON.stringify({ openai: { type: "api_key", key: "SECRET-LEAK" } }), { mode: 0o600 });
	return path;
}

function migrate(receipt: string, dir: string) {
	return executeAuthBrokerCommand(
		["auth-broker", "migrate", "--from-local", "--dry-run", `--backup-receipt=${receipt}`],
		{ agentDir: dir },
	);
}

describe("auth broker migrate receipt safety", () => {
	it("rejects a dry-run when the backup path already exists and does not overwrite it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "senpi-broker-migrate-"));
		try {
			authJson(dir);
			const receipt = join(dir, "receipt.json");
			writeFileSync(`${receipt}.backup`, "pre-existing", { mode: 0o600 });
			const result = await migrate(receipt, dir);
			expect(result?.exitCode).not.toBe(0);
			expect(await readFile(`${receipt}.backup`, "utf8")).toBe("pre-existing");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not write the auth.json secret through a pre-created symlink at the backup path", async () => {
		const dir = mkdtempSync(join(tmpdir(), "senpi-broker-migrate-src-"));
		const target = mkdtempSync(join(tmpdir(), "senpi-broker-migrate-tgt-"));
		try {
			authJson(dir);
			const receipt = join(dir, "receipt.json");
			const attackerTarget = join(target, "stolen");
			symlinkSync(attackerTarget, `${receipt}.backup`);
			const result = await migrate(receipt, dir);
			expect(result?.exitCode).not.toBe(0);
			expect(existsSync(attackerTarget)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(target, { recursive: true, force: true });
		}
	});
});
