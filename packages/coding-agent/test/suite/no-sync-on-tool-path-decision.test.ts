import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { auditSessionPath, type SessionPathFinding } from "./session-path-audit.ts";

// senpi#4565: every tool call is decided on the host thread, from paths the call names. A synchronous probe of such a
// path (lstat, stat, readdir, readlink, realpath, exists, access, open) blocks the whole host when the path's mount does
// not answer. The session-path audit never reached these files (its roots stop short of builtin extensions), which is
// how decide-target.ts canonicalForCompare's realpathSync.native froze a host. Here they are roots, and none is allowed.
const packageRoot = resolve(import.meta.dirname, "../..");
const builtin = "src/core/extensions/builtin";
const DECISION_FILES = [
	`${builtin}/permission-system/parsers.ts`,
	`${builtin}/permission-system/read-permission.ts`,
	`${builtin}/permission-system/external-dir.ts`,
	`${builtin}/permission-system/external-pattern.ts`,
	`${builtin}/permission-system/external-spellings.ts`,
	`${builtin}/permission-system/decide-target.ts`,
	`${builtin}/permission-system/auto-paths.ts`,
	`${builtin}/permission-system/auto-policy.ts`,
	`${builtin}/terminal/file-monitor-registration.ts`,
	`${builtin}/terminal/file-monitor-source.ts`,
	`${builtin}/terminal/file-monitor-check.ts`,
] as const;
const PATH_PROBES = /^(lstat|stat|readdir|readlink|realpath|exists|access|open|opendir)Sync$|^realpathSync\.native$/;

const describeFinding = (finding: SessionPathFinding): string =>
	`${finding.file}:${finding.lines.join(",")} ${finding.api} in ${finding.symbol}`;

describe("no synchronous path probe on the tool-call decision path", () => {
	let probes: readonly SessionPathFinding[];

	beforeAll(() => {
		probes = auditSessionPath({ packageRoot, roots: [...DECISION_FILES] }).filter(
			(finding) => finding.kind === "sync-fs" && PATH_PROBES.test(finding.callee.replace(/^fs\./, "")),
		);
	});

	it("reaches none, in the decision files or the shared helpers they call", () => {
		// Given the call graph rooted at the permission parsers, the decision and the monitor registration
		// When the synchronous path probes it reaches are listed
		const reached = probes.map(describeFinding);
		// Then there are none
		expect(reached).toEqual([]);
	});
});
