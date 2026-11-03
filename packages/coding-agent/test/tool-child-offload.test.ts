// senpi#3566 todo 8: `pi.registerChildModule` + `ctx.offload` through the session's runtime-selected dispatcher. Under
// `child` the module runs on the session's tool child (spawned on demand, never in-process); under `in-process` the
// server imports and runs it. A module that cannot be loaded fails offload_module_unavailable in both.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolRuntimeKind } from "../src/cli/tool-runtime.ts";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createHarness } from "./suite/harness.ts";

const EXTENSION = `export default function (pi) {
	pi.registerChildModule({ id: "probe", module: "./mod.ts", export: "probe" });
	pi.registerChildModule({ id: "dies-once", module: "./mod.ts", export: "diesOnce", idempotent: true });
	pi.registerChildModule({ id: "dies-once-strict", module: "./mod.ts", export: "diesOnce" });
	pi.registerChildModule({ id: "missing", module: "./absent.ts", export: "probe" });
	pi.registerChildModule({ id: "broken", module: "./broken.ts", export: "probe" });
	let inlineError = "accepted";
	try {
		pi.registerChildModule({ id: "inline", module: () => 1, export: "x" });
	} catch (error) {
		inlineError = error.code;
	}
	globalThis.__offloadInline = inlineError;
	pi.on("session_start", (_event, ctx) => {
		const atStart = ctx.offload("probe", { word: "start" });
		// Only the first test awaits it; a test that kills the child may end it first.
		atStart.catch(() => {});
		globalThis.__offloadAtStart = atStart;
	});
}
`;

const MODULE = `import { existsSync, writeFileSync } from "node:fs";
export function probe(args) {
	return { pid: process.pid, echo: args.word };
}
export function diesOnce(args) {
	if (!existsSync(args.marker)) {
		writeFileSync(args.marker, "");
		process.kill(process.pid, "SIGKILL");
	}
	return { pid: process.pid, survived: true };
}
`;

const BROKEN = `import { writeFileSync } from "node:fs";
writeFileSync(process.env.SENPI_OFFLOAD_BROKEN_MARKER ?? "/dev/null", String(process.pid));
throw new Error("this module fails while loading");
`;

async function sessionWith(runtime: ToolRuntimeKind) {
	const dir = mkdtempSync(join(tmpdir(), "offload-"));
	const extensionDir = join(dir, "ext");
	mkdirSync(extensionDir);
	writeFileSync(join(extensionDir, "index.ts"), EXTENSION);
	writeFileSync(join(extensionDir, "mod.ts"), MODULE);
	writeFileSync(join(extensionDir, "broken.ts"), BROKEN);
	const loader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: join(dir, "agent"),
		settingsManager: SettingsManager.inMemory({}),
		additionalExtensionPaths: [join(extensionDir, "index.ts")],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	const harness = await createHarness({ resourceLoader: loader, cwd: dir, toolRuntime: runtime });
	const records: AgentSessionEvent[] = [];
	harness.session.subscribe((event) => {
		if (event.type === "session_tool_child") records.push(event);
	});
	await harness.session.bindExtensions({});
	const ctx = harness.session.extensionRunner.createContext();
	const offload = (id: string, args: unknown) => {
		if (ctx.offload === undefined) throw new Error("runner context without offload");
		return ctx.offload(id, args);
	};
	return {
		dir,
		harness,
		records,
		offload,
		cleanup: () => {
			harness.cleanup();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		return "resolved";
	} catch (error) {
		return String(Reflect.get(Object(error), "code") ?? error);
	}
}

describe.skipIf(process.platform === "win32")("ctx.offload", () => {
	it("under child, runs from session_start on the session's tool child, spawned on demand", async () => {
		const session = await sessionWith("child");
		try {
			const atStart = (await Reflect.get(globalThis, "__offloadAtStart")) as { pid: number; echo: string };
			expect(atStart.echo).toBe("start");
			expect(atStart.pid).not.toBe(process.pid);
			expect(session.records.some((record) => Reflect.get(record, "state") === "spawned")).toBe(true);
			expect(Reflect.get(globalThis, "__offloadInline")).toBe("offload_bad_registration");
		} finally {
			session.cleanup();
		}
	}, 90_000);

	it("under in-process, runs here and never starts a child", async () => {
		const session = await sessionWith("in-process");
		try {
			const result = (await session.offload("probe", { word: "here" })) as { pid: number; echo: string };
			expect(result).toEqual({ pid: process.pid, echo: "here" });
			expect(session.records).toEqual([]);
			expect(session.harness.session.toolChildRow()).toEqual({ state: "none" });
		} finally {
			session.cleanup();
		}
	}, 90_000);

	it("under child, retries an idempotent module lost to its child's exit once, and never a strict one", async () => {
		const session = await sessionWith("child");
		try {
			const retried = (await session.offload("dies-once", { marker: join(session.dir, "first") })) as {
				pid: number;
				survived: boolean;
			};
			expect(retried.survived).toBe(true);
			expect(retried.pid).not.toBe(process.pid);
			expect(await codeOf(session.offload("dies-once-strict", { marker: join(session.dir, "second") }))).toBe(
				"tool_child_exited",
			);
		} finally {
			session.cleanup();
		}
	}, 90_000);

	it("fails a missing module offload_module_unavailable in both runtimes, and an unknown id typed", async () => {
		for (const runtime of ["child", "in-process"] as const) {
			const session = await sessionWith(runtime);
			try {
				expect(await codeOf(session.offload("missing", {}))).toBe("offload_module_unavailable");
				expect(await codeOf(session.offload("nope", {}))).toBe("offload_unknown_module");
			} finally {
				session.cleanup();
			}
		}
	}, 120_000);

	it("under child, a module that fails to load is never run in-process", async () => {
		const marker = join(mkdtempSync(join(tmpdir(), "offload-broken-")), "loaded-by");
		process.env.SENPI_OFFLOAD_BROKEN_MARKER = marker;
		const session = await sessionWith("child");
		try {
			expect(await codeOf(session.offload("broken", {}))).not.toBe("resolved");
			expect(existsSync(marker)).toBe(true);
			expect(Number(readFileSync(marker, "utf8"))).not.toBe(process.pid);
		} finally {
			delete process.env.SENPI_OFFLOAD_BROKEN_MARKER;
			session.cleanup();
			rmSync(join(marker, ".."), { recursive: true, force: true });
		}
	}, 90_000);
});
