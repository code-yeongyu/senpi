/**
 * senpi#3414 (sisyphuslabs/omo-desktop-app#2465): a session opened with the `full-access` preset
 * must not ask "Trust project folder?": Full access means no prompt anywhere. It trusts its project
 * for that session only (nothing saved), and stops trusting it the moment it leaves Full access.
 * Runs the production router, the in-process registry and the real CLI runtime factory (ONE host
 * per test, like a real daemon), with a project extension that records each load.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { CONFIG_DIR_NAME } from "../../../src/config.ts";
import { AgentSession } from "../../../src/core/agent-session.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { ProjectTrustStore } from "../../../src/core/trust-manager.ts";
import { createCliRuntimeFactory } from "../../../src/main.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";

let scratch: string;
let home: string;
let cwd: string;
let agentDir: string;
let marker: string;
let router: SessionCommandRouter | undefined;
let registry: RpcSessionRegistry | undefined;
const records: Array<Record<string, unknown>> = [];

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "senpi-3414-"));
	home = join(scratch, "home", "user");
	cwd = join(home, "project");
	agentDir = join(scratch, "agent");
	marker = join(scratch, "project-extension-loads");
	await mkdir(join(cwd, CONFIG_DIR_NAME, "extensions"), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		join(cwd, CONFIG_DIR_NAME, "extensions", "marker.ts"),
		`import { appendFileSync } from "node:fs";\nexport default function () { appendFileSync(${JSON.stringify(marker)}, "load\\n"); }\n`,
	);
	vi.stubEnv("HOME", home);
	records.length = 0;
	const parsed = parseArgs(["--mode", "rpc", "--multi-session", "--no-context-files"]);
	registry = new RpcSessionRegistry({
		agentDir,
		createRuntime: createCliRuntimeFactory({ parsed, cwd, agentDir, appMode: "rpc" }),
		closeGraceMs: 1_000,
	});
	// The router answers through the event writer, not as handle()'s return value.
	router = new SessionCommandRouter(
		registry,
		new SessionEventWriter((line) => records.push(JSON.parse(line) as Record<string, unknown>)),
		{ cwd },
	);
});

afterEach(async () => {
	await router?.dispose();
	router = undefined;
	registry = undefined;
	vi.unstubAllEnvs();
	// A retired session can still flush its file after the host disposes it.
	await rm(scratch, { recursive: true, force: true, maxRetries: 5 });
});

const loads = (): number => (existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean).length : 0);

async function open(permissionPreset: string): Promise<string> {
	const before = records.length;
	await router?.handle({ type: "open_session", cwd, permissionPreset });
	const response = records
		.slice(before)
		.find((record) => record.type === "response" && record.command === "open_session");
	if (response?.success !== true)
		throw new Error(`open_session failed: ${JSON.stringify(response ?? records.slice(-3))}`);
	return String((response.data as { sessionId: string }).sessionId);
}

function runtimeOf(sessionId: string) {
	const runtime = registry?.peek(sessionId)?.runtime;
	if (runtime === undefined) throw new Error(`no runtime for ${sessionId}`);
	return runtime;
}

interface Gate {
	readonly loading: Promise<void>;
	release(): void;
}

const GATE_KEY = Symbol.for("senpi-3414-gate");

/**
 * A project extension whose factory, while a gate is armed, reports that it is loading and waits for
 * its release: a reload or a session build stalls inside the project's code (#3420 races). The
 * extension runs in this process, so the test and the factory meet on one global; no file watching.
 */
async function writeGate(projectDir: string = cwd): Promise<void> {
	await mkdir(join(projectDir, CONFIG_DIR_NAME, "extensions"), { recursive: true });
	await writeFile(
		join(projectDir, CONFIG_DIR_NAME, "extensions", "gate.ts"),
		`export default async function () {\n\tconst gate = globalThis[Symbol.for("senpi-3414-gate")];\n\tif (gate) await gate();\n}\n`,
	);
}

function armGate(): Gate {
	let loaded!: () => void;
	let release!: () => void;
	const loading = new Promise<void>((resolve) => {
		loaded = resolve;
	});
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	Reflect.set(globalThis, GATE_KEY, () => {
		Reflect.deleteProperty(globalThis, GATE_KEY);
		loaded();
		return released;
	});
	return { loading, release };
}

describe("Full access trusts the project without asking (#3414)", { timeout: 120_000 }, () => {
	it("a full-access session loads the project's extensions and saves no trust decision", async () => {
		await open("full-access");
		expect(loads()).toBe(1);
		expect(new ProjectTrustStore(agentDir).get(cwd)).toBeNull();
	});

	it("an ask session in the same host does not inherit a full-access session's trust", async () => {
		await open("full-access");
		expect(loads()).toBe(1);
		await open("ask");
		expect(loads()).toBe(1);
	});

	it("a saved 'do not trust' still wins under full access", async () => {
		new ProjectTrustStore(agentDir).set(cwd, false);
		await open("full-access");
		expect(loads()).toBe(0);
	});

	it("moving a session off Full access stops trusting its project at once", async () => {
		const sessionId = await open("full-access");
		const runtime = runtimeOf(sessionId);
		expect(runtime.session.settingsManager.isProjectTrusted()).toBe(true);

		runtime.setPermissionPreset("ask");
		await runtime.projectTrustChange;

		expect(runtime.session.settingsManager.isProjectTrusted()).toBe(false);
		const loader = runtime.session.resourceLoader;
		if (!(loader instanceof DefaultResourceLoader)) throw new Error("expected the default resource loader");
		expect(
			loader
				.getExtensions()
				.extensions.map((extension) => extension.path)
				.filter((path) => path.includes("marker.ts")),
		).toEqual([]);
		expect(new ProjectTrustStore(agentDir).get(cwd)).toBeNull();
	});

	it("a reload already in flight does not put project code back after the trust is withdrawn", async () => {
		await writeGate();
		const runtime = runtimeOf(await open("full-access"));
		const projectExtensions = (): string[] =>
			runtime.session.extensionRunner
				.getExtensionPaths()
				.filter((path) => path.includes(`${sep}project${sep}${CONFIG_DIR_NAME}${sep}extensions${sep}`));
		expect(projectExtensions()).toHaveLength(2);

		// A user reload that stalls inside the project extension's factory, after it read the trust.
		const gate = armGate();
		const userReload = runtime.session.reload();
		await gate.loading;

		runtime.setPermissionPreset("ask");
		const trustChange = runtime.projectTrustChange;
		gate.release();
		await userReload;
		await trustChange;

		expect(runtime.session.settingsManager.isProjectTrusted()).toBe(false);
		// The stalled reload loaded the project's extensions before the trust changed (nothing can undo code
		// that already ran); what must not happen is installing them on the session afterwards.
		expect(projectExtensions()).toEqual([]);
		expect(loads()).toBeGreaterThanOrEqual(1);
	});

	it("going back to Full access trusts the project again and reloads its code", async () => {
		const runtime = runtimeOf(await open("full-access"));
		expect(loads()).toBe(1);

		runtime.setPermissionPreset("ask");
		await runtime.projectTrustChange;
		expect(runtime.session.settingsManager.isProjectTrusted()).toBe(false);

		runtime.setPermissionPreset("full-access");
		await runtime.projectTrustChange;

		expect(runtime.session.settingsManager.isProjectTrusted()).toBe(true);
		expect(loads()).toBe(2);
		expect(new ProjectTrustStore(agentDir).get(cwd)).toBeNull();
	});

	it("a saved 'do not trust' still wins when Full access comes back", async () => {
		const runtime = runtimeOf(await open("full-access"));
		runtime.setPermissionPreset("ask");
		await runtime.projectTrustChange;
		new ProjectTrustStore(agentDir).set(cwd, false);

		runtime.setPermissionPreset("full-access");
		await runtime.projectTrustChange;

		expect(runtime.session.settingsManager.isProjectTrusted()).toBe(false);
		expect(loads()).toBe(1);
	});

	it("a session replacement built under Full access does not go live trusted after a downgrade", async () => {
		await writeGate();
		const runtime = runtimeOf(await open("full-access"));
		const projectExtensions = (): string[] =>
			runtime.session.extensionRunner
				.getExtensionPaths()
				.filter((path) => path.includes(`${sep}project${sep}${CONFIG_DIR_NAME}${sep}extensions${sep}`));
		expect(projectExtensions()).toHaveLength(2);

		// The replacement is built while the session is still Full access, so it loads the project's code.
		const gate = armGate();
		const replacement = runtime.newSession();
		await gate.loading;

		runtime.setPermissionPreset("ask");
		gate.release();
		await replacement;
		await runtime.projectTrustChange;

		expect(runtime.session.settingsManager.isProjectTrusted()).toBe(false);
		expect(projectExtensions()).toEqual([]);
	});

	it("a replacement's project trust is fixed before it becomes the live session", async () => {
		await writeGate();
		const runtime = runtimeOf(await open("full-access"));
		const retired = runtime.session;
		const liveAtTrustChange: boolean[] = [];
		const original = AgentSession.prototype.applyProjectTrustChange;
		const spy = vi.spyOn(AgentSession.prototype, "applyProjectTrustChange").mockImplementation(function (
			this: AgentSession,
		) {
			if (this !== retired) liveAtTrustChange.push(runtime.session === this);
			return original.call(this);
		});
		try {
			const gate = armGate();
			const replacement = runtime.newSession();
			await gate.loading;
			runtime.setPermissionPreset("ask");
			gate.release();
			await replacement;
			await runtime.projectTrustChange;
		} finally {
			spy.mockRestore();
		}
		// The replacement was built trusted; its trust change ran while it was not yet the live session.
		expect(liveAtTrustChange).toEqual([false]);
		expect(runtime.session.settingsManager.isProjectTrusted()).toBe(false);
	});

	it("a switch into another project checks that project's saved trust, not the retired one's", async () => {
		// Project A is saved "trust"; project B has no decision, so B is trusted only through Full access.
		new ProjectTrustStore(agentDir).set(cwd, true);
		const other = join(home, "other");
		await writeGate(other);
		const runtime = runtimeOf(await open("full-access"));

		const gate = armGate();
		const switching = runtime.switchSession(join(scratch, "other-session.jsonl"), { cwdOverride: other });
		await gate.loading;
		runtime.setPermissionPreset("ask");
		gate.release();
		await switching;
		await runtime.projectTrustChange;

		expect(runtime.session.sessionManager.getCwd()).toBe(other);
		expect(runtime.session.settingsManager.isProjectTrusted()).toBe(false);
		expect(
			runtime.session.extensionRunner
				.getExtensionPaths()
				.filter((path) => path.startsWith(join(other, CONFIG_DIR_NAME))),
		).toEqual([]);
	});

	it("a preset change that lands while a replacement's trust is being fixed still reaches the replacement", async () => {
		await writeGate();
		const runtime = runtimeOf(await open("full-access"));
		const retired = runtime.session;
		const original = AgentSession.prototype.applyProjectTrustChange;
		let moved = false;
		const spy = vi.spyOn(AgentSession.prototype, "applyProjectTrustChange").mockImplementation(function (
			this: AgentSession,
		) {
			// The first rebuild of the replacement: the user flips back to Full access meanwhile.
			if (this !== retired && !moved) {
				moved = true;
				runtime.setPermissionPreset("full-access");
			}
			return original.call(this);
		});
		try {
			const gate = armGate();
			const replacement = runtime.newSession();
			await gate.loading;
			runtime.setPermissionPreset("ask");
			gate.release();
			await replacement;
			await runtime.projectTrustChange;
		} finally {
			spy.mockRestore();
		}
		expect(moved).toBe(true);
		expect(runtime.session.settingsManager.isProjectTrusted()).toBe(true);
		expect(runtime.session.extensionRunner.getFlagValues().get("permission-preset")).toBe("full-access");
	});

	it("a replacement that fails after teardown leaves permission changes working for the next session", async () => {
		const runtime = runtimeOf(await open("full-access"));
		const build = Reflect.get(runtime, "createRuntime");
		Reflect.set(runtime, "createRuntime", async () => {
			throw new Error("replacement build failed");
		});
		await expect(runtime.newSession()).rejects.toThrow("replacement build failed");
		Reflect.set(runtime, "createRuntime", build);

		// The live session is the disposed one now: the change is recorded, nothing rebuilds it, and the
		// next replacement goes live under it.
		runtime.setPermissionPreset("ask");
		expect(runtime.session.extensionRunner.getFlagValues().get("permission-preset")).toBe("ask");
		await runtime.newSession();
		await runtime.projectTrustChange;

		expect(runtime.session.extensionRunner.getFlagValues().get("permission-preset")).toBe("ask");
		expect(runtime.session.settingsManager.isProjectTrusted()).toBe(false);
	});

	it("a project reached through a symlink is keyed by its real path: its own saved decision applies", async () => {
		// B's saved "trust" is stored under its real path; the session reaches B through a link.
		const other = join(home, "other");
		await writeGate(other);
		const link = join(home, "other-link");
		await symlink(other, link);
		new ProjectTrustStore(agentDir).set(other, true);
		const runtime = runtimeOf(await open("full-access"));

		const gate = armGate();
		const switching = runtime.switchSession(join(scratch, "linked-session.jsonl"), { cwdOverride: link });
		await gate.loading;
		runtime.setPermissionPreset("ask");
		gate.release();
		await switching;
		await runtime.projectTrustChange;

		expect(runtime.session.settingsManager.isProjectTrusted()).toBe(true);
		expect(new ProjectTrustStore(agentDir).get(link)).toBe(true);
	});

	it("a symlinked project without its own decision does not inherit the project it was opened from", async () => {
		new ProjectTrustStore(agentDir).set(cwd, true);
		const other = join(home, "other");
		await writeGate(other);
		const link = join(home, "other-link");
		await symlink(other, link);
		const runtime = runtimeOf(await open("full-access"));

		const gate = armGate();
		const switching = runtime.switchSession(join(scratch, "linked-session.jsonl"), { cwdOverride: link });
		await gate.loading;
		runtime.setPermissionPreset("ask");
		gate.release();
		await switching;
		await runtime.projectTrustChange;

		expect(runtime.session.settingsManager.isProjectTrusted()).toBe(false);
	});

	it("a trust the user saved during the session survives leaving Full access", async () => {
		const runtime = runtimeOf(await open("full-access"));
		expect(loads()).toBe(1);
		new ProjectTrustStore(agentDir).set(cwd, true);

		runtime.setPermissionPreset("ask");
		await runtime.projectTrustChange;

		expect(runtime.session.settingsManager.isProjectTrusted()).toBe(true);
		expect(loads()).toBe(1);
	});

	it("leaving Full access unloads project code even when a project extension cancels reloads", async () => {
		await writeFile(
			join(cwd, CONFIG_DIR_NAME, "extensions", "veto.ts"),
			'export default function (pi) { pi.on("session_before_reload", () => ({ cancel: true, reason: "kept by the project" })); }\n',
		);
		await mkdir(join(cwd, ".agents", "skills", "project-skill"), { recursive: true });
		await writeFile(
			join(cwd, ".agents", "skills", "project-skill", "SKILL.md"),
			"---\nname: project-skill\ndescription: probe\n---\nbody\n",
		);
		const runtime = runtimeOf(await open("full-access"));
		const projectExtensions = (): string[] =>
			runtime.session.extensionRunner
				.getExtensionPaths()
				.filter((path) => path.includes(`${sep}project${sep}${CONFIG_DIR_NAME}${sep}extensions${sep}`));
		const skillNames = (): string[] => runtime.session.resourceLoader.getSkills().skills.map((skill) => skill.name);
		expect(projectExtensions()).toHaveLength(2);
		expect(skillNames()).toContain("project-skill");
		// The project's veto is live: an ordinary reload would be cancelled.
		expect((await runtime.session.checkReloadVeto()).cancelled).toBe(true);

		runtime.setPermissionPreset("ask");
		await runtime.projectTrustChange;

		expect(runtime.session.settingsManager.isProjectTrusted()).toBe(false);
		expect(projectExtensions()).toEqual([]);
		expect(skillNames()).not.toContain("project-skill");
		expect((await runtime.session.checkReloadVeto()).cancelled).toBe(false);
		expect(runtime.diagnostics.filter((diagnostic) => diagnostic.type === "error")).toEqual([]);
	});
});
