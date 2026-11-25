import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "../../src/config.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { engine } from "../../src/engine/index.ts";
import { TIP_DEFINITIONS } from "../../src/modes/interactive/tips/registry.ts";

const FIXTURE_SESSION = join(__dirname, "..", "fixtures", "before-compaction.jsonl");

let root: string;
let projectDir: string;
let packageDir: string;
let originalCwd: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "engine-functions-")));
	projectDir = join(root, "project");
	packageDir = join(root, "local-package");
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(packageDir, { recursive: true });
	vi.stubEnv("HOME", root);
	vi.stubEnv("PI_OFFLINE", "1");
	originalCwd = process.cwd();
	process.chdir(projectDir);
});

afterEach(() => {
	process.chdir(originalCwd);
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(join(getAgentDir(), "settings.json"), { force: true });
	rmSync(root, { recursive: true, force: true });
});

describe("engine.packages runs each leaf", () => {
	it("installs, lists, updates and removes a local package, reporting each started step", async () => {
		const started: string[] = [];
		const onProgress = (event: { type: string; message?: string }) => {
			if (event.type === "start" && event.message) started.push(event.message);
		};

		expect(await engine.packages.install({ source: packageDir }, { onProgress })).toMatchObject({
			kind: "ok",
			value: { source: packageDir },
		});
		const listed = await engine.packages.list();
		expect(listed.kind === "ok" && listed.value.packages.map((pkg) => pkg.installedPath)).toEqual([packageDir]);
		expect(await engine.packages.update({ source: packageDir })).toMatchObject({
			kind: "ok",
			value: { source: packageDir },
		});
		expect(await engine.packages.update()).toMatchObject({ kind: "ok", value: {} });
		expect(await engine.packages.remove({ source: packageDir }, { onProgress })).toMatchObject({ kind: "ok" });
		expect(started).toEqual([`Installing ${packageDir}...`, `Removing ${packageDir}...`]);
	});

	it("refuses a missing package and a project-local write to an untrusted project", async () => {
		expect(await engine.packages.remove({ source: packageDir })).toMatchObject({
			kind: "error",
			error: { code: "not_found", message: `No matching package found for ${packageDir}` },
		});
		expect(await engine.packages.install({ source: packageDir, local: true, trust: false })).toMatchObject({
			kind: "error",
			error: { code: "project_untrusted" },
		});
	});
});

describe("engine.models runs each leaf", () => {
	it("refreshes the catalogs and answers a refresh failure as a refusal", async () => {
		const refresh = vi.fn(async () => ({ aborted: false, errors: new Map<string, Error>() }));
		vi.spyOn(ModelRuntime, "create").mockResolvedValue({ refresh } as unknown as ModelRuntime);
		expect(await engine.models.update()).toMatchObject({ kind: "ok" });
		refresh.mockResolvedValueOnce({ aborted: false, errors: new Map([["acme", new Error("offline")]]) });
		expect(await engine.models.update()).toMatchObject({
			kind: "error",
			error: { code: "refresh_failed", message: "Could not refresh model catalogs: acme: offline" },
		});
	});

	it("reports an unreadable models.json from discovery", async () => {
		const missing = await engine.models.discover({ provider: "acme" });
		expect(missing).toMatchObject({ kind: "error", error: { code: "discovery_failed" } });
		expect(missing.kind === "error" && missing.error.message).toContain("models.json");
	});

	it("lists the default runtime's models, filtered by the pattern", async () => {
		const none = await engine.models.list({ pattern: "zzzz-no-such-model" });
		expect(none.kind === "ok" && none.value.models).toEqual([]);
		expect(none.kind === "ok" && none.value.available).toBeGreaterThan(0);
		const all = await engine.models.list();
		const models = all.kind === "ok" ? all.value.models : [];
		expect(models.length).toBe(all.kind === "ok" ? all.value.available : -1);
		const sorted = [...models].sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
		expect(models).toEqual(sorted);
	});
});

describe("engine.schedule runs each leaf", () => {
	it("lists nothing, refuses an unknown id and invalid run input, and runs an empty pass", async () => {
		expect(await engine.schedule.list()).toMatchObject({ kind: "ok", value: { jobs: [], invalid: [], runners: [] } });
		expect(await engine.schedule.cancel({ id: "no-such-job" })).toMatchObject({
			kind: "error",
			error: { code: "not_found", message: "No scheduled prompt no-such-job." },
		});
		const events: unknown[] = [];
		const onEvent = (event: unknown) => events.push(event);
		expect(await engine.schedule.run({ concurrency: 0 }, { onEvent })).toMatchObject({
			kind: "error",
			error: { code: "invalid_input", message: "concurrency needs a positive integer" },
		});
		expect(await engine.schedule.run({}, { onEvent })).toMatchObject({ kind: "ok", value: { failed: false } });
		expect(events).toEqual([]);
	});
});

describe("engine queries run each leaf", () => {
	it("refuses a non-positive pid and answers an unattested one", async () => {
		expect(await engine.sessionOfPid({ pid: 0 })).toMatchObject({ kind: "error", error: { code: "invalid_input" } });
		expect(await engine.sessionOfPid({ pid: process.pid })).toMatchObject({
			kind: "ok",
			value: { attested: false, pid: process.pid },
		});
	});

	it("exports a session file to HTML and refuses a missing one", async () => {
		const session = join(root, "session.jsonl");
		copyFileSync(FIXTURE_SESSION, session);
		const out = join(root, "out.html");
		expect(await engine.sessions.exportHtml({ session, out })).toEqual({
			kind: "ok",
			value: { path: out },
			diagnostics: [],
		});
		expect(readFileSync(out, "utf8")).toContain("<html");
		expect(await engine.sessions.exportHtml({ session: join(root, "missing.jsonl") })).toMatchObject({
			kind: "error",
			error: { code: "export_failed", message: `File not found: ${join(root, "missing.jsonl")}` },
		});
	});

	it("answers every tip of the catalog", () => {
		expect(engine.tips().value.map((tip) => tip.id)).toEqual(TIP_DEFINITIONS.map((tip) => tip.id));
	});

	it("measures the prompt of the default session", async () => {
		const sizes = await engine.promptSizes();
		expect(sizes.kind).toBe("ok");
		expect(sizes.kind === "ok" && sizes.value.total.bytes).toBeGreaterThan(0);
		expect(sizes.kind === "ok" && sizes.value.sections.length).toBeGreaterThan(0);
	});
});

describe("engine.host runs each leaf", () => {
	it("answers the shard path and an empty gc", async () => {
		expect(await engine.host.shardPath({ kind: "p", owner: "x" })).toMatchObject({
			kind: "ok",
			value: {
				outcome: "done",
				payload: { kind: "p", socket: join(getAgentDir(), "rpc", "shards", "p-945b87278a044a9c.sock") },
			},
		});
		expect(await engine.host.gc()).toMatchObject({ kind: "ok", value: { payload: { removed: [], kept: [] } } });
	});

	it("refuses status and stop without a host, and a bad stop", async () => {
		expect(await engine.host.status()).toMatchObject({
			kind: "error",
			error: { code: "refused", details: { payload: { reachable: false } } },
		});
		expect(await engine.host.stop()).toMatchObject({
			kind: "error",
			error: { code: "refused", message: "unknown_owner" },
		});
		expect(await engine.host.stop({ wait_ms: 5 })).toMatchObject({ kind: "error", error: { code: "usage" } });
	});

	it("refuses ensure and handoff with an unreadable launch spec before contacting any host", async () => {
		const spec = join(root, "missing-spec.json");
		for (const result of [
			await engine.host.ensure({ launch_spec: spec }),
			await engine.host.handoff({ launch_spec: spec }),
		]) {
			expect(result).toMatchObject({
				kind: "error",
				error: { code: "usage", message: "launch_spec_unreadable", details: { payload: { action: "error" } } },
			});
		}
	});
});
