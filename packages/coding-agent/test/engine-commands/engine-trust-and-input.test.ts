import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME, getAgentDir } from "../../src/config.ts";
import { engine } from "../../src/engine/index.ts";

let root: string;
let projectDir: string;
let originalCwd: string;
const terminals: { stream: NodeJS.ReadStream | NodeJS.WriteStream; had: PropertyDescriptor | undefined }[] = [];

function pretendTerminal(): void {
	for (const stream of [process.stdin, process.stdout]) {
		terminals.push({ stream, had: Object.getOwnPropertyDescriptor(stream, "isTTY") });
		Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
	}
}

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "engine-trust-")));
	projectDir = join(root, "project");
	mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
	writeFileSync(
		join(projectDir, CONFIG_DIR_NAME, "settings.json"),
		JSON.stringify({ packages: ["npm:@project/pkg"] }),
	);
	vi.stubEnv("HOME", root);
	originalCwd = process.cwd();
	process.chdir(projectDir);
});

afterEach(() => {
	for (const { stream, had } of terminals.splice(0)) {
		if (had) Object.defineProperty(stream, "isTTY", had);
		else Reflect.deleteProperty(stream, "isTTY");
	}
	process.chdir(originalCwd);
	vi.unstubAllEnvs();
	rmSync(join(getAgentDir(), "settings.json"), { force: true });
	rmSync(root, { recursive: true, force: true });
});

describe("an exported function never reads a terminal (review M2)", () => {
	it("refuses with trust_required, naming the input, where the project needs a trust decision", async () => {
		pretendTerminal();
		const refusals = [
			await engine.packages.list(),
			await engine.packages.update(),
			await engine.packages.install({ source: join(root, "pkg") }),
			await engine.packages.remove({ source: join(root, "pkg") }),
			await engine.config.resources(),
			await engine.config.resources({ local: true }),
		];
		for (const refusal of refusals) {
			expect(refusal).toMatchObject({
				kind: "error",
				error: { code: "trust_required", details: { input: "trust" } },
			});
		}
	});

	it("answers with the trust the input gives, and never defaults to trusted", async () => {
		pretendTerminal();
		const approved = await engine.packages.list({ trust: true });
		expect(approved.kind === "ok" && approved.value.packages.map((pkg) => pkg.source)).toEqual(["npm:@project/pkg"]);
		const declined = await engine.packages.list({ trust: false });
		expect(declined.kind === "ok" && declined.value.packages).toEqual([]);
	});
});

describe("a required input omitted at run time is a typed refusal (review M3)", () => {
	const omitted = (value: unknown) => value as never;

	it("refuses model discovery without a provider, with no input at all, and with a non-string provider", async () => {
		for (const input of [{}, undefined, { provider: 7 }]) {
			expect(await engine.models.discover(omitted(input))).toMatchObject({
				kind: "error",
				error: { code: "invalid_input", details: { input: "provider" } },
			});
		}
	});

	it("refuses every other leaf whose required input is missing or mistyped", async () => {
		const cases: [Promise<unknown>, string][] = [
			[engine.packages.install(omitted({})), "source"],
			[engine.packages.remove(omitted(undefined)), "source"],
			[engine.schedule.cancel(omitted({})), "id"],
			[engine.schedule.run({}, omitted({})), "onEvent"],
			[engine.sessionOfPid(omitted({ pid: "1" })), "pid"],
			[engine.sessions.exportHtml(omitted({})), "session"],
			[engine.host.shardPath(omitted({ kind: "x", owner: "o" })), "kind"],
			[engine.host.shardPath(omitted({ kind: "p" })), "owner"],
			[engine.config.setResource(omitted({ resource: { type: "skills", path: "/x" }, enabled: true })), "source"],
			[
				engine.config.setResource(omitted({ source: "s", resource: { type: "bogus", path: "/x" }, enabled: true })),
				"type",
			],
			[engine.config.setResource(omitted({ source: "s", resource: { type: "skills", path: "/x" } })), "enabled"],
			[
				engine.config.setResource(omitted({ local: true, source: "s", resource: { type: "skills", path: "/x" } })),
				"state",
			],
		];
		for (const [call, field] of cases) {
			expect(await call, field).toMatchObject({
				kind: "error",
				error: { code: "invalid_input", details: { input: field } },
			});
		}
	});
});

describe("config.agentDir answers the versioned record (review L1)", () => {
	it("carries version 1 and ok in the function's own value", () => {
		const selected = engine.config.agentDir();
		expect(selected).toMatchObject({ kind: "ok", value: { version: 1, ok: true, dir: getAgentDir() } });
	});
});
