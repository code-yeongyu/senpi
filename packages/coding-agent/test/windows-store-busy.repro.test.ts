// Throwaway proof, never merged: measures how a locked or held sign-in store reads on Windows. Each case
// prints one `REPRO <case> <json>` line; the run's verdict is read from those lines, not from pass/fail.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { readClaudeCliAccessToken } from "../src/core/extensions/builtin/anthropic-subscription/claude-cli-account-dir.ts";

const onWindows = process.platform === "win32";
const report = (name: string, value: unknown) => console.log(`REPRO ${name} ${JSON.stringify(value)}`);

async function holdOpen(path: string, share: "None" | "Read") {
	const script = [
		`$f = [IO.File]::Open('${path.replace(/'/g, "''")}', 'Open', 'Read', '${share}')`,
		"[Console]::Out.WriteLine('HELD'); [Console]::Out.Flush()",
		"[void][Console]::In.ReadLine(); $f.Close()",
	].join("; ");
	const child: ChildProcessWithoutNullStreams = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
	await new Promise<void>((resolve, reject) => {
		let out = "";
		let err = "";
		const timer = setTimeout(() => reject(new Error(`no HELD from the holder: ${err}`)), 30_000);
		child.stdout.on("data", (chunk) => {
			out += String(chunk);
			if (out.includes("HELD")) {
				clearTimeout(timer);
				resolve();
			}
		});
		child.stderr.on("data", (chunk) => {
			err += String(chunk);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`the holder exited ${code}: ${err}`));
		});
	});
	return {
		release: () =>
			new Promise<void>((resolve) => {
				child.once("exit", () => resolve());
				child.stdin.end("\n");
			}),
	};
}

const errorOf = (error: unknown) =>
	error instanceof Error ? { name: error.name, code: (error as { code?: unknown }).code ?? null, message: error.message } : String(error);

describe("a held sign-in store on this platform", () => {
	const dir = join(tmpdir(), `store-busy-repro-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const authJson = join(dir, "auth.json");
	const seen = (storage: AuthStorage) => ({
		busy: storage.isCredentialStoreBusy(),
		loadError: storage.getLoadError() ?? null,
		hasStoredAccount: storage.get("anthropic") !== undefined,
	});

	beforeEach(() => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(authJson, JSON.stringify({ anthropic: { type: "api_key", key: "fixture-key" } }));
	});
	afterEach(() => {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	});

	test("b1: the store's lock is held when it is first read", async () => {
		const release = await lockfile.lock(authJson, { realpath: false });
		const storage = AuthStorage.create(authJson);
		const whileLocked = seen(storage);
		await release();
		const reloaded = storage.reload();
		report("b1-lock-held", { platform: process.platform, whileLocked, reloaded, afterRelease: seen(storage) });
		expect(existsSync(authJson)).toBe(true);
	});

	test.skipIf(!onWindows)("b2: another process holds auth.json open with no sharing when it is first read", async () => {
		const holder = await holdOpen(authJson, "None");
		let created: AuthStorage | undefined;
		let thrown: unknown = null;
		try {
			created = AuthStorage.create(authJson);
		} catch (error) {
			thrown = errorOf(error);
		}
		const whileHeld = created ? seen(created) : null;
		await holder.release();
		const reloaded = created?.reload() ?? null;
		report("b2-exclusive-handle", { thrown, whileHeld, reloaded, afterRelease: created ? seen(created) : null });
		expect(existsSync(authJson)).toBe(true);
	});

	test.skipIf(!onWindows)("b3: a write while another process reads auth.json without delete sharing", async () => {
		const storage = AuthStorage.create(authJson);
		const before = seen(storage);
		const holder = await holdOpen(authJson, "Read");
		let thrown: unknown = null;
		try {
			await storage.set("anthropic", { type: "api_key", key: "fixture-key-2" });
		} catch (error) {
			thrown = errorOf(error);
		}
		const whileHeld = seen(storage);
		const errors = storage.drainErrors().map(errorOf);
		await holder.release();
		const reloaded = storage.reload();
		report("b3-write-while-read", { before, thrown, errors, whileHeld, reloaded, afterRelease: seen(storage) });
		expect(existsSync(authJson)).toBe(true);
	});

	test.skipIf(!onWindows)("c: another process holds the CLI's .credentials.json open with no sharing", async () => {
		const accountDir = join(dir, "anthropic-subscription-claude", "fixture-account");
		mkdirSync(accountDir, { recursive: true });
		const now = Date.now();
		const credentials = join(accountDir, ".credentials.json");
		writeFileSync(
			credentials,
			JSON.stringify({ claudeAiOauth: { accessToken: "fixture-token", expiresAt: now + 3_600_000 } }),
		);
		const free = await readClaudeCliAccessToken(accountDir, now);
		const holder = await holdOpen(credentials, "None");
		const whileHeld = await readClaudeCliAccessToken(accountDir, now);
		await holder.release();
		const afterRelease = await readClaudeCliAccessToken(accountDir, now);
		report("c-credentials-held", {
			free: free === "fixture-token",
			whileHeld: whileHeld === "fixture-token",
			afterRelease: afterRelease === "fixture-token",
		});
		expect(free).toBe("fixture-token");
	});
});
