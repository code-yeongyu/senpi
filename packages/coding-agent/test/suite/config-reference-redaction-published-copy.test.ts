/**
 * omo#12965, T-C: the redaction slot is a permanent cross-version contract. The module as published in 2026.11.10-3
 * and the branch module (now built on the realm-registry helper) adopt each other's slot in both load orders and
 * redact each other's values. Each order runs in a fresh realm, because the slot is pinned and add-only.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const BRANCH = fileURLToPath(new URL("../../src/core/config-reference-redaction.ts", import.meta.url));
const PUBLISHED = fileURLToPath(
	new URL("../fixtures/realm-registry/config-reference-redaction-2026.11.10-3.ts", import.meta.url),
);
const HELPER = fileURLToPath(new URL("../../../realm-registry/src/index.ts", import.meta.url));

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function bothOrders(first: "published" | "branch"): Record<string, unknown> {
	const root = mkdtempSync(join(tmpdir(), "senpi-redaction-published-"));
	roots.push(root);
	mkdirSync(join(root, "branch"));
	copyFileSync(HELPER, join(root, "realm-registry.ts"));
	writeFileSync(
		join(root, "branch", "redaction.ts"),
		readFileSync(BRANCH, "utf8").replace('"@earendil-works/pi-realm-registry"', '"../realm-registry.ts"'),
	);
	copyFileSync(PUBLISHED, join(root, "published.ts"));
	const second = first === "published" ? "branch" : "published";
	writeFileSync(
		join(root, "main.mjs"),
		[
			'const load = (copy) => import(copy === "branch" ? "./branch/redaction.ts" : "./published.ts");',
			`const one = await load(${JSON.stringify(first)});`,
			`const two = await load(${JSON.stringify(second)});`,
			'one.rememberResolvedReferenceValue("from-first-x12965-qv7k");',
			'two.rememberResolvedReferenceValue("from-second-x12965-qv7k");',
			"process.stdout.write(JSON.stringify({",
			'  firstRedactsSecond: one.redactResolvedReferenceValues("x from-second-x12965-qv7k y"),',
			'  secondRedactsFirst: two.redactResolvedReferenceValues("x from-first-x12965-qv7k y"),',
			"}));",
		].join("\n"),
	);
	const run = spawnSync(process.execPath, [join(root, "main.mjs")], { encoding: "utf8", timeout: 20_000 });
	if (run.status !== 0) throw new Error(`fresh realm exited ${String(run.status)}: ${run.stderr}`);
	return JSON.parse(run.stdout) as Record<string, unknown>;
}

describe("published 2026.11.10-3 redaction copy next to the branch copy (omo#12965)", () => {
	it.each(["published", "branch"] as const)(
		"adopts one slot and redacts across copies when the %s copy loads first",
		(first) => {
			expect(bothOrders(first)).toEqual({
				firstRedactsSecond: "x <redacted> y",
				secondRedactsFirst: "x <redacted> y",
			});
		},
	);
});
