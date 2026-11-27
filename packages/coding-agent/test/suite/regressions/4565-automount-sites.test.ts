import { createRequire, syncBuiltinESMExports } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	answerAutomountTriggersFrom,
	defaultTriggerView,
	type MountView,
} from "../../../../machine-ops/src/files/automount-trigger.ts";
import { existsAtName } from "../../../src/core/extensions/builtin/permission-system/auto-paths.ts";
import { createDispatchAuthorizer } from "../../../src/core/extensions/builtin/permission-system/dispatch-policy.ts";
import { createLocalEventEmitter } from "../../../src/core/extensions/builtin/permission-system/events.ts";
import { isExternalPath } from "../../../src/core/extensions/builtin/permission-system/external-dir.ts";
import {
	canonicalPathCase,
	createExternalPathMatcher,
} from "../../../src/core/extensions/builtin/permission-system/external-pattern.ts";
import { createBuiltinParserRegistry } from "../../../src/core/extensions/builtin/permission-system/parsers.ts";
import { PermissionService } from "../../../src/core/extensions/builtin/permission-system/service.ts";
import { approvedStorePath } from "../../../src/core/extensions/builtin/permission-system/storage.ts";
import { findMovedPath } from "../../../src/core/extensions/builtin/moved-path-guard/resolve.ts";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import { getMissingSessionCwdIssue } from "../../../src/core/session-cwd.ts";
import {
	assertSessionPathsOnThisMachine,
	canonicalSessionPath,
	sessionDirectoryRemoved,
} from "../../../src/modes/rpc/session-path-key.ts";
import { realpathWithoutOpen, realpathWithoutOpenStrict } from "../../../src/utils/paths.ts";

// senpi#4565: on macOS a synchronous probe of a path under /home (an autofs trigger) can park the host thread for
// good. Before the first mount-table read lands, every host-thread probe site must answer such a path from the
// automounter's default map, with zero filesystem calls on it.
const ELSEWHERE = "/home/someone/omo-runs/run-a";
const PROBES = [
	"lstatSync",
	"statSync",
	"readdirSync",
	"readlinkSync",
	"existsSync",
	"accessSync",
	"openSync",
	"opendirSync",
	"realpathSync",
] as const;

const fs: object = createRequire(import.meta.url)("node:fs");
type Probe = (...args: unknown[]) => unknown;
const touched: string[] = [];
const originals = new Map<string, unknown>();
const record =
	(name: string, original: Probe): Probe =>
	(...args: unknown[]): unknown => {
		if (String(args[0]).startsWith("/home/someone")) touched.push(`${name}(${String(args[0])})`);
		return original(...args);
	};
let restoreView = (): void => {};

beforeAll(() => {
	for (const name of PROBES) {
		const original: Probe = Reflect.get(fs, name);
		originals.set(name, original);
		Reflect.set(fs, name, Object.assign(record(name, original), original));
	}
	const realpath: object = Reflect.get(fs, "realpathSync");
	const native: Probe = Reflect.get(realpath, "native");
	originals.set("realpathSync.native", native);
	Reflect.set(realpath, "native", record("realpathSync.native", native));
	syncBuiltinESMExports();
	restoreView = answerAutomountTriggersFrom(
		() => new Promise<MountView>(() => {}),
		{},
		{ fallback: defaultTriggerView("darwin") },
	);
});

afterAll(() => {
	restoreView();
	for (const name of PROBES) Reflect.set(fs, name, originals.get(name));
	Reflect.set(Reflect.get(fs, "realpathSync"), "native", originals.get("realpathSync.native"));
	syncBuiltinESMExports();
});

function decide(toolName: string, input: Record<string, unknown>): string {
	const service = new PermissionService(
		[{ permission: "*", pattern: "*", action: "ask" }],
		[],
		createLocalEventEmitter(),
		"full-access",
		"/tmp/senpi-4565-project",
		"/tmp/senpi-4565-agent",
	);
	const authorizer = createDispatchAuthorizer(
		{ getAllTools: () => [] },
		() => ({ service, parsers: createBuiltinParserRegistry(), preset: "full-access", setupError: null }),
		async () => undefined,
	);
	const ctx = { cwd: "/tmp/senpi-4565-project", sessionManager: undefined } as unknown as ExtensionContext;
	return authorizer.policy({ toolCallId: "call", toolName, input, identity: { owner: {}, metadata: "" } }, ctx).action;
}

const sites: ReadonlyArray<readonly [string, () => unknown, (answer: unknown) => void]> = [
	[
		"monitor command naming two paths (the field case; decide-target.ts canonicalForCompare)",
		() => decide("monitor", { command: `bun waitSentinel.ts ${ELSEWHERE}/t4.done ${ELSEWHERE}/t4.status` }),
		(answer) => expect(answer).toBe("allow"),
	],
	[
		"bash command naming a path (external-dir.ts extractExternalPaths)",
		() => decide("bash", { command: `cat ${ELSEWHERE}/log.txt` }),
		(answer) => expect(answer).toBe("allow"),
	],
	["read of a path (read-permission.ts)", () => decide("read", { path: `${ELSEWHERE}/a.ts` }), () => {}],
	[
		"grep line selector (parsers.ts grepPathStat)",
		() => decide("grep", { pattern: "x", path: `${ELSEWHERE}/a.ts:L1-L2` }),
		() => {},
	],
	[
		"monitor file watch (parsers.ts monitor parent)",
		() => decide("monitor", { path: `${ELSEWHERE}/t4.done` }),
		() => {},
	],
	["external path test", () => isExternalPath(`${ELSEWHERE}/x`, "/tmp"), (answer) => expect(answer).toBe(true)],
	[
		"case recovery (external-pattern.ts canonicalPathCase)",
		() => canonicalPathCase(`${ELSEWHERE}/X.ts`),
		(answer) => expect(answer).toBe("/home/someone/omo-runs/run-a/X.ts"),
	],
	[
		"external pattern match (external-pattern.ts)",
		() => createExternalPathMatcher()(`${ELSEWHERE}/x`, `${ELSEWHERE}/*`),
		() => {},
	],
	[
		"auto name check (auto-paths.ts existsAtName)",
		() => existsAtName(`${ELSEWHERE}/x`),
		(answer) => expect(answer).toBe(true),
	],
	["approvals store key (storage.ts)", () => approvedStorePath("/tmp/senpi-4565-agent", ELSEWHERE), () => {}],
	[
		"open-free walk (utils/paths.ts)",
		() => realpathWithoutOpen(`${ELSEWHERE}/x`),
		(answer) => expect(answer).toBe(`${ELSEWHERE}/x`),
	],
	[
		"strict open-free walk keeps the path verbatim, like a missing tail (utils/paths.ts)",
		() => realpathWithoutOpenStrict(`${ELSEWHERE}/x`),
		(answer) => expect(answer).toBe(`${ELSEWHERE}/x`),
	],
	[
		"session path key (session-path-key.ts canonicalSessionPath)",
		() => canonicalSessionPath(`${ELSEWHERE}/session.jsonl`),
		(answer) => expect(answer).toBe(`${ELSEWHERE}/session.jsonl`),
	],
	[
		"session directory gone",
		() => sessionDirectoryRemoved(`${ELSEWHERE}/session.jsonl`),
		(answer) => expect(answer).toBe(true),
	],
	[
		"session open refuses a cwd that is not on this machine",
		() => {
			try {
				assertSessionPathsOnThisMachine({ cwd: ELSEWHERE });
				return "opened";
			} catch (error) {
				return (error as { code?: string }).code;
			}
		},
		(answer) => expect(answer).toBe("invalid_path"),
	],
	[
		"stored session cwd (session-cwd.ts)",
		() =>
			getMissingSessionCwdIssue({ getCwd: () => ELSEWHERE, getSessionFile: () => "/tmp/s.jsonl" }, "/tmp")
				?.sessionCwd,
		(answer) => expect(answer).toBe(ELSEWHERE),
	],
	[
		"moved-path resolution (moved-path-guard/resolve.ts)",
		() => findMovedPath(`${ELSEWHERE}/x`),
		(answer) => expect(answer).toBeUndefined(),
	],
];

describe("4565 every host-thread probe site answers a path under an unmounted automount without touching it", () => {
	it.each(sites)("%s", (_name, run, check) => {
		// Given the macOS default automount map and no finished mount-table read
		touched.length = 0;

		// When the site handles a path under /home
		const answer = run();

		// Then it answers, and no synchronous filesystem call reached the path
		check(answer);
		expect(touched).toEqual([]);
	});
});
