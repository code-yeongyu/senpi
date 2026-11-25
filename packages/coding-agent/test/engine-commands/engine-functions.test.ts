import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME, getAgentDir } from "../../src/config.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { engine } from "../../src/engine/index.ts";
import { listModelsOf } from "../../src/engine/models.ts";
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

describe("engine.packages", () => {
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
		expect(listed.kind).toBe("ok");
		expect(listed.kind === "ok" && listed.value.packages.map((pkg) => pkg.installedPath)).toEqual([packageDir]);
		expect(await engine.packages.update({ source: packageDir })).toMatchObject({
			kind: "ok",
			value: { source: packageDir },
		});
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
		expect(existsSync(join(projectDir, CONFIG_DIR_NAME, "settings.json"))).toBe(false);
	});
});

describe("engine.models", () => {
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

	it("refuses discovery without a provider and reports an unreadable models.json", async () => {
		expect(await engine.models.discover({ provider: "" })).toMatchObject({
			kind: "error",
			error: { code: "invalid_input" },
		});
		const missing = await engine.models.discover({ provider: "acme" });
		expect(missing).toMatchObject({ kind: "error", error: { code: "discovery_failed" } });
		expect(missing.kind === "error" && missing.error.message).toContain("models.json");
	});

	it("lists models matching the pattern by provider then id, with the models.json load error", () => {
		const model = (provider: string, id: string) => ({ provider, id }) as never;
		const runtime = {
			getError: () => "bad json",
			getModels: () => [model("zeta", "b"), model("alpha", "z"), model("alpha", "a")],
		} as unknown as ModelRuntime;

		const listing = listModelsOf(runtime, {}).value;
		expect(listing.loadError).toBe("bad json");
		expect(listing.available).toBe(3);
		expect(listing.models.map((m) => `${m.provider}/${m.id}`)).toEqual(["alpha/a", "alpha/z", "zeta/b"]);
		expect(listModelsOf(runtime, { pattern: "zeta" }).value.models.map((m) => m.id)).toEqual(["b"]);
	});
});

describe("engine.config", () => {
	it("answers the agent directory selection record", () => {
		expect(engine.config.agentDir()).toMatchObject({
			kind: "ok",
			value: { dir: getAgentDir(), source: "SENPI_CODING_AGENT_DIR", rule: "environment" },
		});
	});

	it("resolves resources, refuses an untrusted local scope, and writes global and project settings", async () => {
		const extension = join(getAgentDir(), "extensions", "probe-7450.ts");
		mkdirSync(join(getAgentDir(), "extensions"), { recursive: true });
		writeFileSync(extension, "export default function () {}\n");
		try {
			expect(await engine.config.resources({ local: true, trust: false })).toMatchObject({
				kind: "error",
				error: { code: "project_untrusted" },
			});
			const resolved = await engine.config.resources();
			expect(resolved.kind).toBe("ok");
			const item =
				resolved.kind === "ok"
					? resolved.value.global.extensions.find((entry) => entry.path === extension)
					: undefined;
			expect(item?.enabled).toBe(true);
			const resource = { type: "extensions", path: extension } as const;
			const source = item?.metadata.source ?? "";

			expect(await engine.config.setResource({ source, resource, enabled: false })).toMatchObject({
				kind: "ok",
				value: { enabled: false },
			});
			const settings = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8")) as {
				extensions?: string[];
			};
			expect(settings.extensions).toEqual(["-extensions/probe-7450.ts"]);

			expect(
				await engine.config.setResource({ local: true, trust: true, source, resource, state: "load" }),
			).toMatchObject({ kind: "ok", value: { enabled: true, state: "load" } });
			const project = JSON.parse(readFileSync(join(projectDir, CONFIG_DIR_NAME, "settings.json"), "utf8")) as {
				extensions?: string[];
			};
			expect(project.extensions).toEqual([extension, `+${extension}`]);

			expect(
				await engine.config.setResource({ source, resource: { type: "skills", path: extension }, enabled: true }),
			).toMatchObject({ kind: "error", error: { code: "not_found" } });
		} finally {
			rmSync(join(getAgentDir(), "extensions"), { recursive: true, force: true });
		}
	});
});

describe("engine.schedule", () => {
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

describe("engine queries", () => {
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
});

describe("engine.host", () => {
	it("answers the shard path and an empty gc, refuses status without a host, and refuses a bad stop", async () => {
		expect(await engine.host.shardPath({ kind: "p", owner: "x" })).toMatchObject({
			kind: "ok",
			value: {
				outcome: "done",
				payload: { kind: "p", socket: join(getAgentDir(), "rpc", "shards", "p-945b87278a044a9c.sock") },
			},
		});
		expect(await engine.host.gc()).toMatchObject({ kind: "ok", value: { payload: { removed: [], kept: [] } } });
		expect(await engine.host.status()).toMatchObject({
			kind: "error",
			error: { code: "refused", details: { payload: { reachable: false } } },
		});
		expect(await engine.host.stop({ wait_ms: 5 })).toMatchObject({ kind: "error", error: { code: "usage" } });
	});
});
