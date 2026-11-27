import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "../../src/config.ts";
import { engine, type HostAnswer, type HostCode } from "../../src/engine/index.ts";

type HostResult = EngineResult<HostAnswer, HostCode | "invalid_input">;
import type { EngineResult } from "../../src/engine/result.ts";

const CLI = join(__dirname, "..", "..", "src", "cli.ts");
const FIXTURE_SESSION = join(__dirname, "..", "fixtures", "before-compaction.jsonl");

let root: string;
let projectDir: string;
let packageDir: string;
let originalCwd: string;

function hermeticEnv(): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH ?? "",
		HOME: root,
		TMPDIR: join(root, "tmp"),
		SENPI_CODING_AGENT_DIR: getAgentDir(),
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		NO_COLOR: "1",
	};
}

/** Runs an exported function in a process with exactly the CLI's environment, for answers that read it. */
function fnInCliEnvironment(expression: string): unknown {
	const entry = join(__dirname, "..", "..", "src", "engine", "index.ts");
	const script = `import { engine } from ${JSON.stringify(entry)}; console.log(JSON.stringify(await ${expression}));`;
	const result = spawnSync("bun", ["-e", script], {
		cwd: projectDir,
		encoding: "utf8",
		timeout: 120_000,
		env: hermeticEnv(),
	});
	return JSON.parse(result.stdout);
}

function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync("bun", [CLI, ...args], {
		cwd: projectDir,
		encoding: "utf8",
		timeout: 120_000,
		env: hermeticEnv(),
	});
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function hostExit(result: HostResult): number {
	if (result.kind === "ok") return result.value.outcome === "fallback" ? 4 : 0;
	return { refused: 3, usage: 2, invalid_input: 2, failed: 1 }[result.error.code];
}

function hostPayload(result: HostResult): unknown {
	return result.kind === "ok" ? result.value.payload : result.error.details?.payload;
}

beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "engine-parity-")));
	projectDir = join(root, "project");
	packageDir = join(root, "local-package");
	for (const dir of [projectDir, packageDir, join(root, "tmp")]) mkdirSync(dir, { recursive: true });
	originalCwd = process.cwd();
	process.chdir(projectDir);
	vi.stubEnv("HOME", root);
	vi.stubEnv("PI_OFFLINE", "1");
});

afterAll(() => {
	process.chdir(originalCwd);
	vi.unstubAllEnvs();
	rmSync(join(getAgentDir(), "settings.json"), { force: true });
	rmSync(root, { recursive: true, force: true });
});

describe("packages: the CLI and the function answer alike (senpi#7450)", () => {
	it("install", async () => {
		const printed = cli("install", packageDir);
		const installed = await engine.packages.install({ source: packageDir });
		expect(printed.status).toBe(0);
		expect(installed.kind === "ok" && `Installed ${installed.value.source}\n`).toBe(
			printed.stdout.split("\n").slice(-2).join("\n"),
		);
	});

	it("list", async () => {
		const listed = await engine.packages.list();
		const paths = listed.kind === "ok" ? listed.value.packages.map((pkg) => pkg.installedPath) : [];
		expect(paths).toEqual([packageDir]);
		expect(cli("list").stdout).toContain(`    ${packageDir}\n`);
	});

	it("update", async () => {
		const updated = await engine.packages.update({ source: packageDir });
		expect(updated.kind === "ok" && `Updated ${updated.value.source}\n`).toBe(
			cli("update", "--extension", packageDir).stdout,
		);
	});

	it("remove, refusal included", async () => {
		expect(cli("remove", packageDir).stdout).toContain(`Removed ${packageDir}\n`);
		const removed = await engine.packages.remove({ source: packageDir });
		const printed = cli("remove", packageDir);
		expect(printed.status).toBe(1);
		expect(removed.kind === "error" && `${removed.error.message}\n`).toBe(printed.stderr);
	});
});

describe("models: the CLI and the function answer alike", () => {
	it("update", async () => {
		const refreshed = await engine.models.update();
		const printed = cli("update", "--models");
		expect(refreshed.kind === "ok" ? 0 : 1).toBe(printed.status);
		expect(printed.stdout).toBe(refreshed.kind === "ok" ? "Model catalogs refreshed\n" : "");
	});

	it("discover refusal", async () => {
		const discovered = await engine.models.discover({ provider: "acme" });
		const printed = cli("models", "discover", "acme");
		expect(printed.status).toBe(1);
		expect(discovered.kind === "error" && `Error: ${discovered.error.message}\n`).toBe(printed.stderr);
	});

	it("list", async () => {
		const listed = await engine.models.list({ pattern: "claude-opus" });
		const ids = listed.kind === "ok" ? listed.value.models.map((model) => model.id) : [];
		const rows = cli("--list-models", "claude-opus").stdout.trim().split("\n").slice(1);
		expect(ids.length).toBeGreaterThan(0);
		expect(rows.map((row) => row.split(/\s+/)[1])).toEqual(ids);
	});
});

describe("config, schedule and queries: the CLI and the function answer alike", () => {
	it("config agent-dir", () => {
		const selected = engine.config.agentDir();
		expect(selected.kind === "ok" && selected.value).toEqual(JSON.parse(cli("config", "agent-dir", "--json").stdout));
	});

	it("config resources refusal", async () => {
		const refused = await engine.config.resources({ local: true, trust: false });
		const printed = cli("config", "-l", "--no-approve");
		expect(printed.status).toBe(1);
		expect(refused.kind === "error" && `${refused.error.message}\n`).toBe(printed.stderr);
	});

	it("schedule list", async () => {
		const { observedAt: _observedAt, ...listed } = (await engine.schedule.list()).value;
		expect(JSON.parse(cli("schedule", "list", "--json").stdout)).toEqual(listed);
	});

	it("schedule cancel refusal", async () => {
		const cancelled = await engine.schedule.cancel({ id: "nope" });
		const printed = cli("schedule", "cancel", "nope");
		expect(printed.status).toBe(1);
		expect(cancelled.kind === "error" && `${cancelled.error.message}\n`).toBe(printed.stderr);
	});

	it("schedule run", async () => {
		const lines: string[] = [];
		const ran = await engine.schedule.run({}, { onEvent: (event) => lines.push(`${JSON.stringify(event)}\n`) });
		const printed = cli("schedule", "run");
		expect(ran.kind === "ok" && ran.value.failed ? 1 : 0).toBe(printed.status);
		expect(lines.join("")).toBe(printed.stdout);
	});

	it("session-of-pid", async () => {
		const answered = await engine.sessionOfPid({ pid: 1 });
		const printed = JSON.parse(cli("session-of-pid", "1", "--json").stdout) as Record<string, unknown>;
		expect(answered.kind === "ok" && { version: 1, ok: true, ...answered.value }).toEqual(printed);
	});

	it("session export", async () => {
		const session = join(root, "session.jsonl");
		copyFileSync(FIXTURE_SESSION, session);
		const exported = await engine.sessions.exportHtml({ session, out: join(root, "by-function.html") });
		expect(cli("--export", session, join(root, "by-cli.html")).stdout).toBe(
			`Exported to: ${join(root, "by-cli.html")}\n`,
		);
		expect(exported.kind).toBe("ok");
		expect(readFileSync(join(root, "by-function.html"), "utf8")).toBe(
			readFileSync(join(root, "by-cli.html"), "utf8"),
		);
	});

	it("prompt sizes", () => {
		const sizes = fnInCliEnvironment("engine.promptSizes()") as { kind: string; value: unknown };
		expect(sizes.kind).toBe("ok");
		expect(sizes.value).toEqual(JSON.parse(cli("--print-prompt-sizes").stdout));
	});

	it("tips", () => {
		expect(engine.tips().value).toEqual(JSON.parse(cli("--list-tips").stdout));
	});
});

describe("host: the CLI and the function answer alike, payload and exit code", () => {
	const spec = () => join(root, "missing-spec.json");
	const cases: [string, () => Promise<HostResult>, () => string[]][] = [
		[
			"ensure refusal",
			() => engine.host.ensure({ launch_spec: spec() }),
			() => ["host", "ensure", "--launch-spec", spec(), "--json"],
		],
		[
			"handoff refusal",
			() => engine.host.handoff({ launch_spec: spec() }),
			() => ["host", "handoff", "--launch-spec", spec(), "--json"],
		],
		["status refusal", () => engine.host.status(), () => ["host", "status", "--json"]],
		["stop refusal", () => engine.host.stop(), () => ["host", "stop", "--json"]],
		["gc", () => engine.host.gc(), () => ["host", "gc", "--json"]],
		[
			"shard-path",
			() => engine.host.shardPath({ kind: "i", owner: "o" }),
			() => ["host", "shard-path", "--kind", "i", "--owner", "o", "--json"],
		],
	];
	for (const [name, call, argv] of cases) {
		it(name, async () => {
			const answered = await call();
			const printed = cli(...argv());
			expect(hostExit(answered)).toBe(printed.status);
			expect(hostPayload(answered)).toEqual(JSON.parse(printed.stdout));
		});
	}
});
