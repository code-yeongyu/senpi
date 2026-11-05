import { vi } from "vitest";

// Every synchronous filesystem call the loader makes runs on the shared RPC host's event loop.
const { calls } = vi.hoisted(() => ({ calls: [] as Array<{ readonly name: string; readonly path: string }> }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const counted = <T extends (...args: never[]) => unknown>(name: string, fn: T): T =>
		((...args: never[]) => {
			calls.push({ name, path: String(args[0]) });
			return fn(...args);
		}) as T;
	const names = ["readdirSync", "statSync", "lstatSync", "existsSync", "openSync", "readFileSync"] as const;
	const wrapped: Record<string, unknown> = Object.fromEntries(
		names.map((name) => [name, counted(name, actual[name] as never)]),
	);
	wrapped.realpathSync = Object.assign(counted("realpathSync", actual.realpathSync), {
		native: counted("realpathSync.native", actual.realpathSync.native),
	});
	return { ...actual, ...wrapped, default: { ...actual, ...wrapped } };
});

import { mkdirSync, mkdtempSync, realpathSync, rmSync, type Stats, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { dedupePathsByPackageIdentity } from "../../../src/core/package-identity.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createSkillSourceCache, readUserSkillSource } from "../../../src/core/skill-source-cache.ts";

let root: string;
let cwd: string;
let agentDir: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "senpi-11437-")));
	cwd = join(root, "project");
	agentDir = join(root, "agent");
	mkdirSync(join(cwd, ".git"), { recursive: true });
	mkdirSync(agentDir);
	vi.stubEnv("HOME", root);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

const AN_HOUR_MS = 3_600_000;
const AN_HOUR_AGO = new Date(Date.now() - AN_HOUR_MS);

/** The cache's racy-write window reads `Date.now()`; tests pin it instead of waiting it out. */
function pinClock(at: number): number {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(at);
	return at;
}

function skill(dir: string, name: string, description = "synthetic skill"): string {
	const file = join(dir, name, "SKILL.md");
	mkdirSync(join(dir, name), { recursive: true });
	writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`);
	return file;
}

function installedEarlier(file: string): string {
	utimesSync(file, AN_HOUR_AGO, AN_HOUR_AGO);
	return file;
}

/** The reporter's layout: N skills in ~/.agents/skills, 82% of them copied byte-for-byte into a second root. */
function installSkills(count: number): { readonly dirs: number; readonly bundled: string } {
	const copies = Math.floor(count * 0.82);
	for (let index = 0; index < count; index++)
		installedEarlier(skill(join(root, ".agents", "skills"), `skill-${index}`));
	for (let index = 0; index < copies; index++) installedEarlier(skill(join(agentDir, "skills"), `skill-${index}`));
	const bundled = join(root, "bundled");
	installedEarlier(skill(bundled, "bundled-skill"));
	// Installed skills were last changed long ago: move the clock past their change time (ctime included).
	pinClock(Date.now() + AN_HOUR_MS);
	return { dirs: count + copies + 1, bundled };
}

/** What every RPC `open_session` does: a fresh loader, `reload()`, then the extensions' `resources_discover` paths. */
async function openSession(bundled: string): Promise<DefaultResourceLoader> {
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		noExtensions: true,
		settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
	});
	await loader.reload();
	loader.extendResources({
		skillPaths: [{ path: bundled, metadata: { source: "extension", scope: "user", origin: "top-level" } }],
	});
	return loader;
}

it("keeps the synchronous filesystem calls of a session open within a per-skill-directory budget", async () => {
	const { dirs, bundled } = installSkills(150);
	await openSession(bundled);
	calls.length = 0;
	const loader = await openSession(bundled);
	expect(loader.getSkills().skills).toHaveLength(151);
	expect(calls.length).toBeLessThanOrEqual(20 * dirs + 400);
});

it("re-reads no unchanged SKILL.md on the next open and still picks up an edited one", async () => {
	const { bundled } = installSkills(50);
	await openSession(bundled);
	calls.length = 0;
	await openSession(bundled);
	const skillReads = () =>
		calls.filter((call) => /^(openSync|readFileSync)$/.test(call.name) && call.path.endsWith("SKILL.md"));
	expect(skillReads().length).toBe(0);

	// skill-45 lives only in ~/.agents/skills; the lower-numbered ones are shadowed by their user-root copies.
	const edited = skill(join(root, ".agents", "skills"), "skill-45", "edited description that is longer");
	calls.length = 0;
	const loader = await openSession(bundled);
	expect(new Set(skillReads().map((call) => call.path))).toEqual(new Set([edited]));
	expect(loader.getSkills().skills.find((entry) => entry.name === "skill-45")?.description).toBe(
		"edited description that is longer",
	);
});

it("reads a just-written SKILL.md again even when a same-size rewrite keeps its stat stamp", () => {
	const file = skill(root, "racy", "first");
	const { dev, ino, size } = statSync(file);
	const sameStamp = { dev, ino, size, mtimeMs: Date.now(), ctimeMs: Date.now() } as Stats;
	expect(readUserSkillSource(file, sameStamp)).toContain("description: first");
	writeFileSync(file, "---\nname: racy\ndescription: later\n---\nbody\n");
	expect(readUserSkillSource(file, sameStamp)).toContain("description: later");
});

it("reads a same-size rewrite again when its mtime was back-dated and only ctime moved within one coarse tick", () => {
	const now = pinClock(Date.UTC(2026, 9, 27, 12));
	const file = skill(root, "backdated", "first");
	const { dev, ino, size } = statSync(file);
	// cp -p, tar, rsync -t and utimes restore an old mtime; only the kernel-set ctime says "just changed",
	// and a coarse ctime clock gives both writes the same value.
	const backdated = { dev, ino, size, mtimeMs: now - AN_HOUR_MS, ctimeMs: now } as Stats;
	expect(readUserSkillSource(file, backdated)).toContain("description: first");
	writeFileSync(file, "---\nname: backdated\ndescription: later\n---\nbody\n");
	expect(readUserSkillSource(file, backdated)).toContain("description: later");
});

it("does not keep the whole body of a SKILL.md whose frontmatter never closes", () => {
	const now = pinClock(Date.UTC(2026, 9, 27, 12));
	const file = join(root, "unclosed", "SKILL.md");
	mkdirSync(join(root, "unclosed"));
	writeFileSync(file, `---\nname: unclosed\ndescription: no closing fence\n${"x".repeat(200 * 1024)}\n`);
	const { dev, ino, size } = statSync(file);
	const installed = { dev, ino, size, mtimeMs: now - AN_HOUR_MS, ctimeMs: now - AN_HOUR_MS } as Stats;
	calls.length = 0;
	expect(readUserSkillSource(file, installed).length).toBeGreaterThan(200 * 1024);
	expect(readUserSkillSource(file, installed).length).toBeGreaterThan(200 * 1024);
	expect(calls.filter((call) => call.name === "openSync" && call.path === file).length).toBe(2);
});

it("keeps the cached sources within a byte budget, dropping the oldest first", () => {
	const now = Date.UTC(2026, 9, 27, 12);
	const read = createSkillSourceCache({ maxEntryBytes: 1024, maxTotalBytes: 250 }, () => now);
	const files = ["a", "b", "c"].map((name) => skill(root, name, "d".repeat(60)));
	const settled = (file: string) =>
		({ ...statSync(file), mtimeMs: now - AN_HOUR_MS, ctimeMs: now - AN_HOUR_MS }) as Stats;
	for (const file of files) read(file, settled(file));
	calls.length = 0;
	for (const file of [...files].reverse()) read(file, settled(file));
	const opened = calls.filter((call) => call.name === "openSync").map((call) => call.path);
	expect(opened).toEqual([files[0]]);
});

it("looks up the nearest package.json once per directory, not once per skill", () => {
	const skillsRoot = join(root, "a", "b", "c", "skills");
	const paths = Array.from({ length: 100 }, (_, index) => skill(skillsRoot, `skill-${index}`));
	calls.length = 0;
	expect(dedupePathsByPackageIdentity(paths)).toEqual(paths);
	const lookups = calls.filter((call) => call.name === "existsSync" && call.path.endsWith("package.json"));
	// 100 skill folders, then the shared ancestors up to the filesystem root, each looked up once.
	expect(lookups.length).toBe(new Set(lookups.map((call) => call.path)).size);
});

it("reads ignore files found in the directory listing instead of probing each name per directory", async () => {
	const { bundled } = installSkills(20);
	writeFileSync(join(root, ".agents", "skills", ".gitignore"), "skill-3/\n");
	calls.length = 0;
	const loader = await openSession(bundled);
	const names = loader.getSkills().skills.map((entry) => entry.name);
	// The copy in the second root still loads; only the ignored ~/.agents/skills folder is skipped.
	expect(loader.getSkills().skills.find((entry) => entry.name === "skill-3")?.filePath).toBe(
		join(agentDir, "skills", "skill-3", "SKILL.md"),
	);
	expect(names).toHaveLength(21);
	const probes = calls.filter((call) => call.name === "existsSync" && /[\\/]\.(git|fd)?ignore$/.test(call.path));
	expect(probes.length).toBe(0);
});
