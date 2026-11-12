/**
 * The macOS measurement of the move-record stamp's premise (senpi#6463) runs only for the files its path filter
 * names. These rows hold that the filter names every file its rule says it must and none that is gone, that both
 * triggers carry the same list, that it runs under the versions the macOS job of CI runs under, and that the
 * runner's clock is put back.
 *
 * It is a test of this package: the files the rule is about are this package's sources.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../../../../..", import.meta.url));
const FILE = ".github/workflows/move-stamp-age-macos.yml";
const SOURCE = "packages/coding-agent/src";
const text = readFileSync(join(root, FILE), "utf8");

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
/** The value at a path of keys, or `undefined` where the path leaves the document. */
const at = (value: unknown, ...keys: string[]): unknown =>
	keys.reduce<unknown>((node, key) => (isRecord(node) ? node[key] : undefined), value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const workflow: unknown = parse(text);
const filter = list(at(workflow, "on", "pull_request", "paths")).map(String);
const steps = (document: unknown, job: string): unknown[] => list(at(document, "jobs", job, "steps"));

/** The rule's pattern, read from the one place it is written: the workflow's own header. */
const stated = /^#\s+stamp-files:\s+(\S.*)$/m.exec(text)?.[1];

/** Every `.ts` file under `dir`, as a `/`-separated path from the repository root. */
function sources(dir: string): string[] {
	return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
		const path = `${dir}/${entry.name}`;
		if (entry.isDirectory()) return sources(path);
		return entry.name.endsWith(".ts") ? [path] : [];
	});
}

/** The version a job gives an action: `field` of the step that uses `action`. */
function pinOf(document: unknown, job: string, action: string, field: string): unknown {
	const step = steps(document, job).find((candidate) => String(at(candidate, "uses") ?? "").startsWith(`${action}@`));
	return at(step, "with", field);
}

describe("the macOS measurement of the move-record stamp (senpi#6463)", () => {
	it("#given the rule its header states #then it runs for every production source file that chooses, writes or reads a stamp's clock, and for itself", () => {
		expect(stated, "the workflow's header states the rule's pattern on a stamp-files line").toBeDefined();
		const rule = new RegExp(stated ?? "$^");
		const touching = sources(SOURCE).filter((path) => rule.test(readFileSync(join(root, path), "utf8")));

		expect([...filter].sort()).toEqual([...touching, FILE].sort());
	});

	it("#given its path filter #then every file it names exists, so a renamed file cannot leave it never running", () => {
		for (const path of filter) expect(existsSync(join(root, path)), path).toBe(true);
	});

	it("#given its two triggers #then it runs for the same files on a pull request and on main", () => {
		expect(at(workflow, "on", "push", "paths")).toEqual(at(workflow, "on", "pull_request", "paths"));
		expect(at(workflow, "on", "push", "branches")).toEqual(["main"]);
	});

	it("#given the macOS job of CI #then the measurement runs under the same node and bun versions", () => {
		const ci: unknown = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));
		for (const [action, field] of [
			["actions/setup-node", "node-version"],
			["oven-sh/setup-bun", "bun-version"],
		] as const) {
			const pin = pinOf(workflow, "stamp-age", action, field);
			expect(pin, action).toBeDefined();
			expect(pin, action).toBe(pinOf(ci, "macos-combined", action, field));
		}
	});

	it("#given its last step #then it runs whatever the measurement did, so the runner's clock is put back", () => {
		expect(at(steps(workflow, "stamp-age").at(-1), "if")).toBe("always()");
	});
});
