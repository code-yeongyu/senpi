import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "../../src/config.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { engine } from "../../src/engine/index.ts";

const CLI = join(__dirname, "..", "..", "src", "cli.ts");
const CANARY = "sk-canary-e1as-auth-7451";

let root: string;

function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync("bun", [CLI, ...args], {
		cwd: root,
		encoding: "utf8",
		timeout: 120_000,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: root,
			SENPI_CODING_AGENT_DIR: getAgentDir(),
			PI_OFFLINE: "1",
			PI_SKIP_VERSION_CHECK: "1",
			NO_COLOR: "1",
		},
	});
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "engine-auth-")));
	mkdirSync(getAgentDir(), { recursive: true });
	writeFileSync(
		join(getAgentDir(), "auth.json"),
		JSON.stringify({ openai: { type: "api_key", key: CANARY } }),
		{ mode: 0o600 },
	);
});

afterEach(() => vi.restoreAllMocks());

afterAll(() => {
	rmSync(join(getAgentDir(), "auth.json"), { force: true });
	rmSync(root, { recursive: true, force: true });
});

describe("engine.auth.check answers status only, as the command does (senpi#7451)", () => {
	it("answers the record `auth check --json` prints, refresh off as --no-refresh", async () => {
		const printed = cli("auth", "check", "--provider", "openai", "--json", "--no-refresh");
		expect(printed.status).toBe(0);
		const checked = await engine.auth.check({ provider: "openai", refresh: false });
		expect(checked.kind === "ok" && checked.value).toEqual(JSON.parse(printed.stdout));
		expect(JSON.stringify(checked)).not.toContain(CANARY);
	});

	it("answers the same record with the command's default refresh", async () => {
		const printed = cli("auth", "check", "--provider", "openai", "--json");
		const checked = await engine.auth.check({ provider: "openai" });
		expect(checked.kind === "ok" && checked.value).toEqual(JSON.parse(printed.stdout));
	});

	it("refuses a check that names neither provider nor model, with the command's words", async () => {
		const printed = cli("auth", "check");
		expect(printed.status).toBe(2);
		const checked = await engine.auth.check({});
		expect(checked).toMatchObject({ kind: "error", error: { code: "invalid_input" } });
		expect(checked.kind === "error" && `Error: ${checked.error.message}\n`).toBe(printed.stderr);
	});
});

describe("the provider-credential operations refuse and never read the store (security design 5.5)", () => {
	it.each([
		["credentials", () => engine.auth.credentials({ provider: "openai" })],
		["apiKey", () => engine.auth.apiKey({ provider: "openai" })],
		["bearerToken", () => engine.auth.bearerToken({ provider: "openai", min_expiry_ms: 60_000 })],
	])("%s refuses delivery before the store is opened", async (_call, call) => {
		const store = vi.spyOn(AuthStorage, "create");
		const runtime = vi.spyOn(ModelRuntime, "create");
		const answer = await call();
		expect(answer).toMatchObject({ kind: "error", error: { code: "delivery_unavailable" } });
		expect(JSON.stringify(answer)).not.toContain(CANARY);
		expect(store).not.toHaveBeenCalled();
		expect(runtime).not.toHaveBeenCalled();
	});

	it("refuses the inputs the command refuses, with its words", async () => {
		const printed = cli("auth", "print-api-key");
		expect(printed.status).toBe(1);
		const answer = await engine.auth.apiKey({});
		expect(answer).toMatchObject({ kind: "error", error: { code: "invalid_input" } });
		expect(`Error: ${answer.error.message}\n`).toBe(printed.stderr);
		expect(await engine.auth.bearerToken({ provider: "openai", min_expiry_ms: -1 })).toMatchObject({
			kind: "error",
			error: { code: "invalid_input", message: "--min-expiry must use a duration such as 30m or 1h" },
		});
	});

	it("leaves the print commands unchanged: approved changes B1 and B2 do not ship in this slice", () => {
		expect(cli("auth", "print-api-key", "--provider", "openai")).toMatchObject({ status: 0, stdout: `${CANARY}\n` });
	});
});
