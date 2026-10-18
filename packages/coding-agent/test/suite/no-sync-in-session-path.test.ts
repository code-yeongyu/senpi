import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { auditSessionPath, findingKey, type SessionPathFinding } from "./session-path-audit.ts";

/**
 * One session must never freeze the shared host. The audit walks the transitive call
 * graph rooted at session command handling (registry, binding, connection handler,
 * command router, agent session, auth storage, every tool) and judges what it reaches:
 *
 * - blocking primitives (`execSync`, `execFileSync`, `spawnSync`, `Bun.spawnSync`,
 *   `Bun.sleepSync`, `Atomics.wait`) FAIL unless the ledger already records that exact
 *   call site with the reason it is still there;
 * - synchronous filesystem calls are REPORTED against the ledger: a new call site or an
 *   extra call in a ledgered function fails, removing one never does.
 *
 * Until the credential and footer probes go async, the unledgered blocking set is
 * `src/core/resolve-config-value.ts` and `src/core/footer-data-provider.ts`, so this
 * file is expected to fail on exactly those two.
 */
const packageRoot = resolve(import.meta.dirname, "../..");
const ledgerPath = resolve(import.meta.dirname, "no-sync-in-session-path.ledger.json");

const ledgerEntry = z.object({
	file: z.string().min(1),
	api: z.string().min(1),
	symbol: z.string().min(1),
	count: z.number().int().positive(),
	note: z.string().min(1),
});
const ledgerSchema = z.object({
	documentation: z.string().min(1),
	blocking: z.array(ledgerEntry),
	syncFs: z.array(ledgerEntry),
});
type LedgerEntry = z.infer<typeof ledgerEntry>;

const ledger = ledgerSchema.parse(JSON.parse(readFileSync(ledgerPath, "utf-8")));

/** Human-readable call site: what a failure must name for the fix to be obvious. */
function describeFinding(finding: SessionPathFinding): string {
	return `${finding.file}:${finding.lines.join(",")} ${finding.api} in ${finding.symbol} (x${finding.count})`;
}

/** Call sites the ledger does not already cover, by count. */
function unledgered(
	findings: readonly SessionPathFinding[],
	kind: SessionPathFinding["kind"],
	baseline: readonly LedgerEntry[],
): string[] {
	const allowed = new Map(baseline.map((entry) => [findingKey(entry), entry.count]));
	return findings
		.filter((finding) => finding.kind === kind && finding.count > (allowed.get(findingKey(finding)) ?? 0))
		.map(describeFinding);
}

describe("no blocking work on the RPC session path", () => {
	let findings: readonly SessionPathFinding[];

	beforeAll(() => {
		findings = auditSessionPath({ packageRoot });
	}, 180_000);

	it("finds the session path at all", () => {
		// Given the call-graph walk over the shipped tree
		// When its findings are grouped by file
		const files = new Set(findings.map((finding) => finding.file));
		// Then the roots' own neighbourhood is represented, so an empty result can never pass as green
		expect(files.has("src/core/session-manager.ts")).toBe(true);
		expect(files.has("src/core/auth-storage.ts")).toBe(true);
	});

	it("reaches no blocking primitive that the ledger does not already record", () => {
		// Given the checked-in blocking ledger
		// When the reachable blocking primitives are compared against it
		const introduced = unledgered(findings, "blocking", ledger.blocking);
		// Then nothing blocks the host loop beyond the recorded, bounded call sites
		expect(introduced).toEqual([]);
	});

	it("reports no synchronous filesystem call beyond the checked-in ledger", () => {
		// Given the checked-in sync-fs ledger (the transcript path is deliberately sync and named in it)
		// When the reachable synchronous filesystem calls are compared against it
		const introduced = unledgered(findings, "sync-fs", ledger.syncFs);
		// Then no new sync read or write appeared on the session path
		expect(introduced).toEqual([]);
	});

	it("keeps the ledger free of entries the session path no longer reaches", () => {
		// Given the ledger, which may only shrink as call sites are made async
		// When each entry is looked up in today's findings
		const live = new Set(findings.map((finding) => findingKey(finding)));
		const stale = [...ledger.blocking, ...ledger.syncFs]
			.filter((entry) => !live.has(findingKey(entry)))
			.map((entry) => `${entry.file} ${entry.api} in ${entry.symbol}`);
		// Then every ledger entry still describes a real call site (removals are pruned, never left to rot)
		expect(stale).toEqual([]);
	});

	it("fails when a blocking call is introduced on the path, including behind an import alias", () => {
		// Given a module that calls `spawnSync` through an alias, and a caller one level above it
		const fixture = resolve(import.meta.dirname, "fixtures/session-path-blocking-fixture.ts");
		// When it is seeded as a session-path root
		const withFixture = auditSessionPath({ packageRoot, extraRoots: [fixture] });
		const found = withFixture.filter((finding) => finding.file.endsWith("session-path-blocking-fixture.ts"));
		// Then the audit reports it as blocking, resolved back to the aliased primitive, plus its sync read
		expect(found.map((finding) => `${finding.kind} ${finding.api} in ${finding.symbol}`).sort()).toEqual([
			"blocking runProcessSync in fixtureBlockingProbe",
			"sync-fs readFileSync in fixtureSyncRead",
		]);
		expect(unledgered(withFixture, "blocking", ledger.blocking)).toEqual(
			expect.arrayContaining(found.filter((finding) => finding.kind === "blocking").map(describeFinding)),
		);
	}, 180_000);
});
