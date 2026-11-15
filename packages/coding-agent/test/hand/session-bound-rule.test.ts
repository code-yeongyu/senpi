// senpi#6749 (#6773 review): `ToolDefinition.sessionBound` marks exactly the tools that need the calling session's RECORD
// (the session port's read half); the session's IDENTITY rides every call and binds nothing. The expected flag of every
// tool the hand serves comes from running it on a hand call that carries the identity and no record: a tool is bound
// exactly when it refuses with the typed `session_record_unavailable`. Every other outcome is classified by its typed
// code or as a run, never skipped; a tool that runs is still bound when it touches a session-scoped store the loop
// owns (goal, /loop, scheduled prompts): it writes there, or its outcome changes when those stores are blocked. Guards the `describe_tools` protocol contract the hosted loop routes calls by.
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterEach, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { getAgentDir } from "../../src/config.ts";
import { goalStoreRef } from "../../src/core/extensions/builtin/goal/store-ref.ts";
import { scheduleDir } from "../../src/core/extensions/builtin/schedule/store.ts";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import type { SessionUnavailableCode } from "../../src/core/session-unavailable.ts";
import { grantLooplessExecuteToRemoteExecutor } from "../../src/modes/rpc/loopless-execute-grant.ts";
import { createLooplessRuntimeFactory, type LooplessRuntime } from "../../src/modes/rpc/runtime-factory-loopless.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Valid calls for tools whose own checks reject a schema sample, so their probe reaches what they read. */
const VALID_CALLS: Readonly<Record<string, unknown>> = {
	bash: { command: "true" },
	monitor: { description: "probe", command: "printf 'x\\n'" },
	schedule_prompt: { action: "list" },
	schedule_wakeup: { stop: true, reason: "probe" },
	todo: { op: "view" },
};
const CHILDREN = { type: "rpc", target: "children", description: "probe" };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** A minimal call that satisfies a tool's JSON schema: required fields only, the first choice of each union. */
function sample(schema: unknown): unknown {
	if (!isRecord(schema)) return "probe";
	if ("const" in schema) return schema.const;
	if (Array.isArray(schema.enum)) return schema.enum[0];
	const branches = schema.anyOf ?? schema.oneOf;
	if (Array.isArray(branches)) return sample(branches[0]);
	if (schema.type === "number" || schema.type === "integer") return 1;
	if (schema.type === "boolean") return false;
	if (schema.type === "array") return [];
	if (schema.type !== "object" && !isRecord(schema.properties)) return "probe";
	const properties = isRecord(schema.properties) ? schema.properties : {};
	const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
	return Object.fromEntries(required.map((name) => [name, sample(properties[name])]));
}

type Outcome =
	| { readonly kind: "ran" }
	| { readonly kind: "refused"; readonly code: SessionUnavailableCode | undefined };

const CODES: readonly SessionUnavailableCode[] = [
	"session_record_unavailable",
	"session_identity_unavailable",
	"loop_side_unavailable",
];

function outcomeOf(result: AgentToolResult<unknown>): Outcome {
	if (result.isError !== true) return { kind: "ran" };
	const code = isRecord(result.details) ? result.details.code : undefined;
	return { kind: "refused", code: CODES.find((known) => known === code) };
}

async function handRuntime(cwd: string, extension: (pi: ExtensionAPI) => void): Promise<LooplessRuntime> {
	const configuration = {
		parsed: parseArgs(["--mode", "rpc", "--no-skills", "--no-context-files"]),
		cwd,
		agentDir: getAgentDir(),
		appMode: "rpc" as const,
	};
	// The remote executor's grant runs the tool_call handlers, as on a real hand.
	const runtime = await createLooplessRuntimeFactory(configuration, {
		extensionFactories: [extension],
		executeGrant: grantLooplessExecuteToRemoteExecutor(),
		twoSidedHome: "hand",
	})({ cwd });
	cleanups.push(() => runtime.dispose());
	return runtime;
}

async function scratchCwd(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "senpi-session-bound-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	await mkdir(cwd, { recursive: true });
	return cwd;
}

/** Runs `work` inside a hand call that carries the session's identity and none of its record. */
async function withIdentityOnly(
	cwd: string,
	work: (runtime: LooplessRuntime) => Promise<void>,
): Promise<LooplessRuntime> {
	let ready: LooplessRuntime | undefined;
	const runtime = await handRuntime(cwd, (pi) => {
		pi.on("input", async () => {
			if (ready !== undefined) await work(ready);
			return { action: "continue" as const };
		});
	});
	ready = runtime;
	const reply = await runtime.runLoopHooks("input", {
		sessionId: "probe-session",
		idle: true,
		inputId: "probe-input",
		text: "probe",
		source: "rpc",
		attribution: "user",
	});
	expect(JSON.stringify(reply)).not.toContain('"errors"');
	return runtime;
}

const execute = (runtime: LooplessRuntime, name: string, args: unknown) =>
	runtime.execute(name, `probe-${name}`, args, AbortSignal.timeout(20_000));

/** The session-scoped stores the loop owns, where a hand without a session file keeps them (goal, /loop, scheduled prompts). */
function storeRoots(cwd: string): string[] {
	const noFile = { getSessionFile: () => undefined, getSessionDir: () => "", getSessionId: () => "probe-session" };
	return [goalStoreRef(noFile, cwd).baseDir, join(getAgentDir(), "extensions", "loop"), scheduleDir(getAgentDir())];
}

async function filesUnder(roots: readonly string[]): Promise<string[]> {
	const found: string[] = [];
	for (const root of roots)
		for (const entry of await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []))
			if (entry.isFile()) found.push(join(entry.parentPath, entry.name));
	return found.sort();
}

interface Probe {
	readonly outcome: Outcome;
	readonly wroteStore: boolean;
}

/** Every tool the hand serves, called once with the session's identity and no record; `blocked`: each store root is a file. */
async function probeAll(
	cwd: string,
	blocked: boolean,
): Promise<{ probes: Map<string, Probe>; runtime: LooplessRuntime }> {
	const roots = storeRoots(cwd);
	for (const root of roots) await rm(root, { recursive: true, force: true });
	if (blocked)
		for (const root of roots) {
			await mkdir(dirname(root), { recursive: true });
			await writeFile(root, "blocked");
		}
	// The scheduled-prompt dir also holds the process's runner leases, so only the session-keyed dirs count as writes.
	const keyed = roots.slice(0, 2);
	const probes = new Map<string, Probe>();
	const runtime = await withIdentityOnly(cwd, async (hand) => {
		for (const [name, entry] of [...hand.definitions]) {
			const before = await filesUnder(keyed);
			const outcome = outcomeOf(await execute(hand, name, VALID_CALLS[name] ?? sample(entry.definition.parameters)));
			probes.set(name, { outcome, wroteStore: (await filesUnder(keyed)).join() !== before.join() });
		}
		await execute(hand, "kill_bash", { all: true });
	});
	for (const root of roots) await rm(root, { recursive: true, force: true });
	return { probes, runtime };
}

it("sessionBound marks exactly the served tools that need the session's record or a session-scoped store the loop owns", async () => {
	const cwd = await scratchCwd();
	const open = await probeAll(cwd, false);
	const blocked = await probeAll(cwd, true);
	const served = [...open.runtime.definitions.keys()];
	expect([...open.probes.keys()].sort()).toEqual([...served].sort());

	const key = (outcome: Outcome | undefined) => JSON.stringify(outcome);
	const observed = Object.fromEntries(
		[...open.probes].map(([name, probe]) => {
			const needsRecord = probe.outcome.kind === "refused" && probe.outcome.code === "session_record_unavailable";
			// A blocked store root fails a read and a write alike, so a changed outcome is a touch either way.
			return [name, needsRecord || key(probe.outcome) !== key(blocked.probes.get(name)?.outcome)];
		}),
	);
	const declared = Object.fromEntries(
		served.map((name) => [name, open.runtime.definitions.get(name)?.definition.sessionBound === true]),
	);
	expect(declared).toEqual(observed);
	const unboundWriters = [...open.probes]
		.filter(([name, probe]) => !observed[name] && probe.wroteStore)
		.map(([name]) => name);
	expect(unboundWriters).toEqual([]);
	expect(Object.keys(observed).filter((name) => observed[name])).toEqual(
		expect.arrayContaining(["todo", "schedule_wakeup", "create_goal", "get_goal"]),
	);
	expect(observed.monitor).toBe(false);
	expect(observed.bash).toBe(false);
}, 300_000);

it("monitor watches the calling session's children with the identity the call carries", async () => {
	let watched: Outcome | undefined;
	await withIdentityOnly(await scratchCwd(), async (hand) => {
		watched = outcomeOf(await execute(hand, "monitor", CHILDREN));
		await execute(hand, "kill_bash", { all: true });
	});
	expect(watched).toEqual({ kind: "ran" });
}, 60_000);

it("monitor refuses a children watch with session_identity_unavailable when no identity reaches it", async () => {
	const runtime = await handRuntime(await scratchCwd(), () => {});
	const outcome = outcomeOf(await execute(runtime, "monitor", CHILDREN));
	expect(outcome).toEqual({ kind: "refused", code: "session_identity_unavailable" });
}, 60_000);
