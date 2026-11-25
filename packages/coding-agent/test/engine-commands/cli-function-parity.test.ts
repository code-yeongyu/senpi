import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "../../src/config.ts";
import { engine, ENGINE_COMMANDS } from "../../src/engine/index.ts";

const CLI = join(__dirname, "..", "..", "src", "cli.ts");

let root: string;
let projectDir: string;
let originalCwd: string;

function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync("bun", [CLI, ...args], {
		cwd: projectDir,
		encoding: "utf8",
		timeout: 120_000,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: root,
			TMPDIR: join(root, "tmp"),
			SENPI_CODING_AGENT_DIR: getAgentDir(),
			PI_OFFLINE: "1",
			PI_SKIP_VERSION_CHECK: "1",
			NO_COLOR: "1",
		},
	});
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "engine-parity-")));
	projectDir = join(root, "project");
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(join(root, "tmp"), { recursive: true });
	originalCwd = process.cwd();
	process.chdir(projectDir);
	vi.stubEnv("HOME", root);
});

afterEach(() => {
	rmSync(join(getAgentDir(), "settings.json"), { force: true });
});

afterAll(() => {
	process.chdir(originalCwd);
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

describe("the CLI and the exported function answer the same data for the same input (senpi#7450)", () => {
	it("config agent-dir", () => {
		const printed = JSON.parse(cli("config", "agent-dir", "--json").stdout) as Record<string, unknown>;
		const selected = engine.config.agentDir();
		expect(selected.kind === "ok" && { version: 1, ok: true, ...selected.value }).toEqual(printed);
	});

	it("session-of-pid refuses the same pid", async () => {
		expect(cli("session-of-pid", "0", "--json").status).toBe(2);
		expect(await engine.sessionOfPid({ pid: 0 })).toMatchObject({ kind: "error", error: { code: "invalid_input" } });
	});

	it("session-of-pid answers the same record", async () => {
		const printed = JSON.parse(cli("session-of-pid", "1", "--json").stdout) as Record<string, unknown>;
		const answered = await engine.sessionOfPid({ pid: 1 });
		expect(answered.kind === "ok" && { version: 1, ok: true, ...answered.value }).toEqual(printed);
	});

	it("schedule list", async () => {
		const { observedAt: _observedAt, ...listed } = (await engine.schedule.list()).value;
		expect(JSON.parse(cli("schedule", "list", "--json").stdout)).toEqual(listed);
	});

	it("schedule cancel of an unknown id", async () => {
		const cancelled = await engine.schedule.cancel({ id: "nope" });
		const printed = cli("schedule", "cancel", "nope");
		expect(printed.status).toBe(1);
		expect(cancelled.kind === "error" && `${cancelled.error.message}\n`).toBe(printed.stderr);
	});

	it("host shard-path", async () => {
		const shard = await engine.host.shardPath({ kind: "i", owner: "o" });
		expect(shard.kind === "ok" && shard.value.payload).toEqual(
			JSON.parse(cli("host", "shard-path", "--kind", "i", "--owner", "o", "--json").stdout),
		);
	});

	it("host gc", async () => {
		const gc = await engine.host.gc();
		expect(gc.kind === "ok" && gc.value.payload).toEqual(JSON.parse(cli("host", "gc", "--json").stdout));
	});

	it("host status refused without a host", async () => {
		const status = await engine.host.status();
		const printed = cli("host", "status", "--json");
		expect(printed.status).toBe(3);
		expect(status.kind === "error" && status.error.details?.payload).toEqual(JSON.parse(printed.stdout));
	});

	it("packages list", async () => {
		const listed = await engine.packages.list();
		expect(listed.kind === "ok" && listed.value.packages).toEqual([]);
		expect(cli("list").stdout).toBe("No packages installed.\n");
	});

	it("packages remove of an absent source", async () => {
		const source = join(root, "absent");
		const removed = await engine.packages.remove({ source });
		const printed = cli("remove", source);
		expect(printed.status).toBe(1);
		expect(removed.kind === "error" && `${removed.error.message}\n`).toBe(printed.stderr);
	});

	it("models discover with an unreadable models.json", async () => {
		const discovered = await engine.models.discover({ provider: "acme" });
		const printed = cli("models", "discover", "acme");
		expect(printed.status).toBe(1);
		expect(discovered.kind === "error" && `Error: ${discovered.error.message}\n`).toBe(printed.stderr);
	});

	it("session export of a missing file", async () => {
		const session = join(root, "missing.jsonl");
		const exported = await engine.sessions.exportHtml({ session });
		const printed = cli("--export", session);
		expect(printed.status).toBe(1);
		expect(exported.kind === "error" && `Error: ${exported.error.message}\n`).toBe(printed.stderr);
	});
});

describe("the gated inputs are inputs of the exported functions (senpi#7451)", () => {
	it("host status reaches the endpoint the selector names, as --socket does", async () => {
		const socket = join(root, "named.sock");
		const status = await engine.host.status({ endpoint: { socket } });
		const printed = cli("host", "status", "--socket", socket, "--json");
		expect(printed.status).toBe(3);
		expect(status.kind === "error" && status.error.details?.payload).toEqual(JSON.parse(printed.stdout));
		expect(status.kind === "error" && status.error.details?.payload).toMatchObject({ socket });
	});

	it("refuses a presenter channel on any descriptor but 4, before contacting a host", async () => {
		const ensured = await engine.host.ensure({ presenter: { bootstrap_fd: 3 } as never });
		expect(ensured).toMatchObject({
			kind: "error",
			error: { code: "usage", details: { payload: { detail: "presenter.bootstrap_fd must be 4" } } },
		});
	});

	it("maps every endpoint, key-root, presenter and setup flag to an input field, and the launch key to a handle", () => {
		for (const command of ENGINE_COMMANDS) {
			for (const flag of command.flags) {
				const name = flag.names[0] ?? "";
				if (["--socket", "--rpc-key-root", "--mcp-presenter-fd", "--mcp-presenter-enforcement"].includes(name)) {
					expect(flag.mapping, `${command.call} ${name}`).toMatchObject({ kind: "input" });
					expect(flag.mapping.kind === "input" && flag.mapping.field).toMatch(/^(endpoint|presenter)\./u);
				}
				if (["models.list", "promptSizes"].includes(command.call) && !flag.required) {
					expect(flag.mapping.kind === "input" && flag.mapping.field, `${command.call} ${name}`).toMatch(
						/^setup\./u,
					);
				}
				if (name === "--api-key") expect(flag.mapping).toEqual({ kind: "handle", field: "api_key" });
			}
		}
		const launchCalls = ENGINE_COMMANDS.filter((command) => command.call.startsWith("launch.")).map((c) => c.call);
		expect(launchCalls).toEqual([
			"launch.interactive",
			"launch.print",
			"launch.rpc",
			"launch.hand",
			"launch.headless",
		]);
		for (const call of launchCalls) {
			const command = ENGINE_COMMANDS.find((entry) => entry.call === call);
			expect(
				command?.flags.some((flag) => flag.names[0] === "--api-key"),
				call,
			).toBe(true);
		}
	});

	it("names an exported function for every command", () => {
		for (const command of ENGINE_COMMANDS) {
			const member = command.call
				.split(".")
				.reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], engine);
			expect(typeof member, command.call).toBe("function");
		}
	});
});
