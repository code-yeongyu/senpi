// senpi#5645 (S40 PR 2, design v2.6): the argument-typing class, over EVERY admitted shape. Each shape is filled with a
// valid sample; then every flag is followed by an injected `--output=`, every non-path slot gets an outside path, and
// every path slot is confined on a real repository (outside target, symlinked last component). All must be refused.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { planRun } from "../../src/modes/rpc/hand-run-allowlist.ts";
import { confinePaths } from "../../src/modes/rpc/hand-run-checks.ts";
import { type Item, type Kind, SHAPES } from "../../src/modes/rpc/hand-run-grammar.ts";

const SAMPLE: Readonly<Record<Kind, string>> = {
	rev: "HEAD",
	range: "HEAD~1..HEAD",
	revish: "HEAD",
	object: "HEAD",
	blobref: "HEAD:a.md",
	ref: "refs/heads/main",
	refpat: "refs/heads/x*",
	branch: "b",
	refspec: "main:main",
	url: "https://example.invalid/r",
	msg: "m",
	count: "1",
	mode: "100644",
	oid: "0".repeat(40),
	filter: "AM",
	fmt: "%H",
	iso: "2026-01-01T00:00:00Z",
	relpath: "a.md",
	gitpath: "index",
	path: "a.md",
	worktree: "../wt",
};

interface Slot {
	readonly at: number;
	readonly kind: Kind;
	readonly prefix: string;
}

function fill(items: readonly Item[], args: string[], slots: Slot[]): void {
	for (const item of items) {
		if (typeof item === "string") args.push(item);
		else if ("optional" in item) fill(item.optional, args, slots);
		else if ("repeat" in item) fill(item.repeat, args, slots);
		else {
			const prefix = "prefix" in item ? item.prefix : "";
			slots.push({ at: args.length, kind: item.kind, prefix });
			args.push(prefix + SAMPLE[item.kind]);
		}
	}
}

const CONTEXT = { uid: 501, platform: "darwin" as const, ownEnv: {} };
const plan = (argv: readonly string[]) => planRun({ exe: "git", argv, env: {} }, CONTEXT);
const INERT: readonly Kind[] = ["msg", "fmt"];

const cases = Object.entries(SHAPES).flatMap(([sub, shapes]) =>
	shapes.map((shape, index) => {
		const args: string[] = [];
		const slots: Slot[] = [];
		fill(shape, args, slots);
		return { name: `${sub} #${index}`, sub, args, slots };
	}),
);

const root = mkdtempSync(join(tmpdir(), "senpi-run-class-"));
const repo = join(root, "repo");
const outside = join(root, "outside.txt");
mkdirSync(repo);
writeFileSync(outside, "secret");
execFileSync("git", ["init", "-q", "--template=", repo]);
symlinkSync(outside, join(repo, "link"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("every admitted shape types every argument (senpi#5645)", () => {
	it.each(cases)("$name: its sample is admitted", ({ sub, args }) => {
		expect(plan([sub, ...args]).ok).toBe(true);
	});

	it.each(cases)("$name: an --output= after any flag is refused", ({ sub, args }) => {
		const flags = args.flatMap((arg, at) => (arg.startsWith("-") && arg !== "-" ? [at] : []));
		const admitted = flags.filter(
			(at) => plan([sub, ...args.slice(0, at + 1), "--output=/tmp/x", ...args.slice(at + 1)]).ok,
		);
		expect(admitted).toEqual([]);
	});

	it.each(cases)("$name: an outside path in a non-path slot is refused", ({ sub, args, slots }) => {
		const typed = slots.filter(
			(slot) => slot.kind !== "path" && slot.kind !== "worktree" && !INERT.includes(slot.kind),
		);
		const admitted = typed.filter(
			({ at, prefix }) => plan([sub, ...args.map((arg, i) => (i === at ? `${prefix}${outside}` : arg))]).ok,
		);
		expect(admitted.map((slot) => slot.kind)).toEqual([]);
	});

	it.each(cases.filter((c) => c.slots.some((slot) => slot.kind === "path" || slot.kind === "worktree")))(
		"$name: every path slot is confined (outside target, symlinked last component)",
		async ({ sub, args, slots }) => {
			const refusals: string[] = [];
			for (const slot of slots.filter((s) => s.kind === "path" || s.kind === "worktree")) {
				for (const value of slot.kind === "path" ? [outside, "link"] : [join(repo, ".git", "hooks"), "link"]) {
					const planned = plan([sub, ...args.map((arg, i) => (i === slot.at ? value : arg))]);
					if (!planned.ok) {
						refusals.push("plan");
						continue;
					}
					expect(planned.paths.map((path) => path.value)).toContain(value);
					refusals.push(
						await confinePaths(planned.paths, repo, {}).then(
							() => "admitted",
							(error: Error) => error.message.split(":")[0] ?? "",
						),
					);
				}
			}
			expect(refusals.filter((refusal) => refusal === "admitted")).toEqual([]);
		},
	);
});
