import { basename, dirname } from "node:path";
import { Check } from "typebox/value";
import { runProcess } from "./gate-process.ts";
import { allowlistSchema, canonical, GateInputError, type GateReport, reportSchema } from "./gate-report.ts";

export type BaselineChange = { readonly key: string; readonly reason: string };

type AllowlistNodes = { readonly nodes: Readonly<Record<string, { readonly additions: readonly string[]; readonly changes?: readonly BaselineChange[] }>> };

/**
 * A `changes` entry approves one edit: only entries this pull request adds count, because an entry merged by
 * an earlier PR approved that PR's value and must not pre-approve a later edit of the same cell. An
 * `additions` entry approves a cell's existence, so every entry at the head counts: a cell approved earlier
 * may still be written into the baseline later (a re-record), and its value is checked against the head.
 */
export function baselineApprovals(input: { readonly base: AllowlistNodes | undefined; readonly head: AllowlistNodes }): {
	readonly changes: readonly BaselineChange[];
	readonly additions: readonly string[];
} {
	const baseNodes = Object.values(input.base?.nodes ?? {});
	const baseChanges = new Set(baseNodes.flatMap((node) => (node.changes ?? []).map((change) => JSON.stringify([change.key, change.reason]))));
	const headNodes = Object.values(input.head.nodes);
	return {
		changes: headNodes.flatMap((node) => node.changes ?? []).filter((change) => !baseChanges.has(JSON.stringify([change.key, change.reason]))),
		additions: headNodes.flatMap((node) => node.additions),
	};
}

type Cells = ReadonlyMap<string, string>;

/**
 * A pull request may change the committed baseline only for cells it lists under an allowlist node's
 * `changes` (with a reason a reviewer reads), and every changed or added cell must equal what the head
 * measures. Without this a PR could change a surface and rewrite the baseline to match, unreviewed.
 */
export function reviewBaselineChanges(input: {
	readonly base: GateReport;
	readonly committed: GateReport;
	readonly report: GateReport;
	readonly changes: readonly BaselineChange[];
	/** Addition keys the allowlist lists; a cell written into the baseline must be one of them. */
	readonly additions: readonly string[];
}): string[] {
	const base = cellsOf(input.base);
	const committed = cellsOf(input.committed);
	const measured = cellsOf(input.report);
	const unmeasured = input.report.unmeasured ?? [];
	const isMeasured = (key: string) => !unmeasured.some((section) => key === section || key.startsWith(`${section}/`));
	const listed = new Set(input.changes.map((change) => change.key));
	const listedAdditions = new Set(input.additions);
	const samePlatform = input.committed.observations?.platform === input.report.observations?.platform;
	const matchesHead = (key: string, value: string) =>
		key.startsWith("legacyContracts/") && !samePlatform ? measured.has(key) : measured.get(key) === value;
	const failures: string[] = [];
	for (const [key, value] of base) {
		const now = committed.get(key);
		if (now === value) continue;
		if (!listed.has(key)) {
			failures.push(`unreviewed baseline change: ${key} (list it under "changes" in test/gate/allowlist.json with a reason)`);
		}
		if (!isMeasured(key)) continue;
		if (now === undefined && measured.has(key)) failures.push(`baseline removes ${key}, but the head still measures it`);
		if (now !== undefined && !matchesHead(key, now)) failures.push(`baseline change to ${key} does not match the head measurement`);
	}
	for (const [key, value] of committed) {
		if (base.has(key)) continue;
		// Without this, writing a new cell into the PR's own baseline would hide it from the additions allowlist.
		if (!listedAdditions.has(key) && !listed.has(key)) {
			failures.push(`unreviewed baseline addition: ${key} (list it under "additions" in test/gate/allowlist.json)`);
		}
		if (!isMeasured(key)) continue;
		if (!matchesHead(key, value)) failures.push(`baseline addition ${key} does not match the head measurement`);
	}
	return failures;
}

function cellsOf(report: GateReport): Cells {
	const cells = new Map<string, string>();
	for (const section of ["prompts", "schemas", "invariants"] as const) {
		for (const [key, value] of Object.entries(report[section])) cells.set(`${section}/${key}`, canonical(value));
	}
	for (const section of ["helperCensus", "imports"] as const) {
		for (const [group, members] of Object.entries(report[section])) {
			for (const member of members) cells.set(`${section}/${group}/${member}`, "present");
		}
	}
	for (const runtime of report.runtimes) cells.set(`runtimes/${runtime.id}`, String(runtime.available));
	const contracts = report.observations?.legacyContracts;
	if (typeof contracts === "object" && contracts !== null) {
		for (const [key, outcome] of Object.entries(contracts)) cells.set(`legacyContracts/${key}`, String(outcome));
	}
	return cells;
}

/**
 * The baseline as it was at the merge base. In a pull request (`GITHUB_BASE_REF` set) the base must
 * resolve, or the gate fails closed: skipping the review would let any baseline edit through. A local
 * run outside a pull request without `--base-ref` keeps today's behaviour and returns undefined.
 */
export async function readBaseBaseline(input: {
	readonly baselinePath: string;
	readonly baseRef?: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<{ readonly base: GateReport; readonly allowlist: AllowlistNodes | undefined; readonly mergeBase: string } | undefined> {
	const pullRequestBase = input.env.GITHUB_BASE_REF?.trim();
	const ref = input.baseRef ?? (pullRequestBase ? `origin/${pullRequestBase}` : undefined);
	if (ref === undefined) return undefined;
	const cwd = dirname(input.baselinePath);
	const mergeBase = await runProcess(["git", "merge-base", "HEAD", ref], cwd);
	if (mergeBase.exitCode !== 0 || mergeBase.stdout.trim() === "") {
		throw new GateInputError(
			`cannot resolve the merge base with ${ref}, so baseline changes cannot be reviewed; the gate job must check out full history (fetch-depth: 0). ${mergeBase.stderr.trim()}`,
		);
	}
	const sha = mergeBase.stdout.trim();
	const shown = await runProcess(["git", "show", `${sha}:./${basename(input.baselinePath)}`], cwd);
	if (shown.exitCode !== 0) throw new GateInputError(`baseline at merge base ${sha}: ${shown.stderr.trim()}`);
	const base: unknown = JSON.parse(shown.stdout);
	if (!Check(reportSchema, base)) throw new GateInputError(`baseline at merge base ${sha}`);
	const allowlistShown = await runProcess(["git", "show", `${sha}:./allowlist.json`], cwd);
	const allowlist = allowlistShown.exitCode === 0 ? parseAllowlist(allowlistShown.stdout, sha) : undefined;
	return { base, allowlist, mergeBase: sha };
}

function parseAllowlist(text: string, sha: string): AllowlistNodes {
	const value: unknown = JSON.parse(text);
	if (!Check(allowlistSchema, value)) throw new GateInputError(`allowlist at merge base ${sha}`);
	return value;
}
