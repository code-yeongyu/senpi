import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { auditSessionPath, movePathFiles, type SessionPathFinding } from "./session-path-audit.ts";

/**
 * A move streams whole session files, bundles and resident blobs, so the move files themselves (`movePathFiles`) may
 * not hold the shared host's event loop: every synchronous fs, crypto or zlib call in them fails here, and neither the
 * ledger nor the baseline may excuse one. Sync calls the move path reaches in shared modules are held by the frozen
 * baseline in `no-sync-in-session-path.test.ts` instead (senpi#3676, senpi#3993).
 */
const packageRoot = resolve(import.meta.dirname, "../..");
const fixture = resolve(import.meta.dirname, "fixtures/move-path-sync-fixture.ts");
const aliasFixture = resolve(import.meta.dirname, "fixtures/aliased-sync-fixture.ts");
const ledger: { readonly blocking: readonly { file: string }[]; readonly syncFs: readonly { file: string }[] } =
	JSON.parse(readFileSync(resolve(import.meta.dirname, "no-sync-in-session-path.ledger.json"), "utf-8"));
const baseline: { readonly entries: readonly { file: string }[] } = JSON.parse(
	readFileSync(resolve(import.meta.dirname, "no-sync-in-session-path.baseline.json"), "utf-8"),
);

const describeFinding = (finding: SessionPathFinding): string =>
	`${finding.file}:${finding.lines.join(",")} ${finding.api} in ${finding.symbol}`;

describe("no synchronous I/O in the move files", () => {
	let findings: readonly SessionPathFinding[];
	const ownFiles = new Set(movePathFiles(packageRoot));

	beforeAll(() => {
		findings = auditSessionPath({
			packageRoot,
			roots: movePathFiles(packageRoot),
			extraRoots: [fixture, aliasFixture],
		});
	}, 180_000);

	it("flags sync calls the three-name list missed, under aliased, named and namespace imports", () => {
		// Given the fixture seeded as an extra root
		// When its findings are picked out
		const found = findings
			.filter((finding) => finding.file.endsWith("move-path-sync-fixture.ts"))
			.map((finding) => `${finding.kind} ${finding.api} in ${finding.symbol}`)
			.sort();
		// Then every call is reported, resolved through its import form
		expect(found).toEqual([
			"sync-fs copyInPlace in fixtureCopyBundle",
			"sync-fs fs.cpSync in fixtureCopyTree",
			"sync-fs openSync in fixtureReadHeader",
			"sync-fs readSync in fixtureReadHeader",
			"sync-fs zlib.gzipSync in fixtureCompress",
		]);
	});

	it("flags the non-import aliasing forms: destructuring, a renamed alias, bind/call and createRequire", () => {
		// Given the aliasing fixture seeded as an extra root
		// When its findings are picked out by their declared callee
		const found = findings
			.filter((finding) => finding.file.endsWith("aliased-sync-fixture.ts"))
			.map((finding) => `${finding.callee} in ${finding.symbol}`)
			.sort();
		// Then each form resolves back to its node:fs declaration
		expect(found).toEqual([
			"copyFileSync in fixtureDestructured",
			"existsSync in fixtureBoundOrCalled",
			"mkdirSync in fixtureRequired",
			"readFileSync in fixtureRenamed",
			"statSync in fixtureBoundOrCalled",
		]);
	});

	it("finds no synchronous I/O in the move feature's own files", () => {
		// Given the call graph rooted at the move commands and modules
		// When the findings inside those files are listed
		const own = findings.filter((finding) => ownFiles.has(finding.file)).map(describeFinding);
		// Then there are none
		expect(own).toEqual([]);
	});

	it("lets no ledger or baseline entry excuse a move-path file", () => {
		// Given the session-path ledger and the shrink-only sync baseline
		// When their entries are matched against the move feature's files
		const excused = [...ledger.blocking, ...ledger.syncFs, ...baseline.entries].filter((entry) =>
			ownFiles.has(entry.file),
		);
		// Then none is excused
		expect(excused).toEqual([]);
	});
});
