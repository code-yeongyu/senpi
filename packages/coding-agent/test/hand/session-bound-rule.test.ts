// senpi#6749 (L1 of #6757's review): `ToolDefinition.sessionBound` marks exactly the tools that cannot run without the
// calling session's record, the session port's read half a loop carries to the hand. The expected flag of each probed
// tool comes from running it on a hand that has no session, not from a list: a tool that fails there because the session
// is absent must declare the flag, and a tool that runs must not. The terminal's background `bash` and `monitor` wake
// their session later and key device-local state by its id, yet run without the record, so they stay unbound (their
// wakes are late results). This guards the `describe_tools` protocol contract the hosted loop routes by.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterEach, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { grantLooplessExecuteToTestHarness } from "../../src/modes/rpc/loopless-execute-grant.ts";
import { createLooplessRuntimeFactory } from "../../src/modes/rpc/runtime-factory-loopless.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** One valid call per tool, so a failure on the hand can only come from what the hand lacks. */
const PROBES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
	["todo", { op: "view" }],
	["get_goal", {}],
	["create_goal", { objective: "probe" }],
	["update_goal", { status: "complete" }],
	["schedule_prompt", { action: "list" }],
	["list_relocation_targets", {}],
	["relocate_session", { target: "probe", reason: "probe" }],
	["bash", { command: "true", run_in_background: true }],
	["monitor", { description: "probe", command: "printf 'x\\n'" }],
	["ls", {}],
];

const SESSION_MEMBERS = new Set(Object.getOwnPropertyNames(SessionManager.prototype));
/** `pi.session` before a session binds it (`session-control-actions.ts`): a sessionless runtime never does. */
const SESSION_CONTROL_UNBOUND = "Extension runtime not initialized";

type Outcome =
	| { readonly ran: true; readonly result: AgentToolResult<unknown> }
	| { readonly ran: false; readonly why: string };

const textOf = (result: AgentToolResult<unknown>): string =>
	result.content.map((part) => (part.type === "text" ? part.text : "")).join("");

/** Whether a failure is the absent session: a session-manager member read on nothing, or the unbound session control. */
function missingSession(why: string): boolean {
	const member = /reading '(\w+)'/.exec(why)?.[1];
	return (member !== undefined && SESSION_MEMBERS.has(member)) || why.startsWith(SESSION_CONTROL_UNBOUND);
}

it("sessionBound marks exactly the probed tools that cannot run on a hand without the calling session", async () => {
	const root = await mkdtemp(join(tmpdir(), "senpi-session-bound-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	const configuration = {
		parsed: parseArgs(["--mode", "rpc", "--no-skills", "--no-context-files"]),
		cwd,
		agentDir,
		appMode: "rpc" as const,
	};
	const runtime = await createLooplessRuntimeFactory(configuration, {
		executeGrant: grantLooplessExecuteToTestHarness(),
	})({ cwd });
	cleanups.push(() => runtime.dispose());

	const outcomes = new Map<string, Outcome>();
	for (const [name, args] of PROBES) {
		const result = await runtime.execute(name, `probe-${name}`, args);
		outcomes.set(name, result.isError === true ? { ran: false, why: textOf(result) } : { ran: true, result });
	}
	// The terminal sessions the probes started end here, before the runtime is disposed.
	for (const outcome of outcomes.values()) {
		const id = outcome.ran ? /ID: (\S+)/.exec(textOf(outcome.result))?.[1] : undefined;
		if (id !== undefined) await runtime.execute("kill_bash", `stop-${id}`, { bash_id: id });
	}

	for (const [name, outcome] of outcomes) {
		if (!outcome.ran)
			expect(missingSession(outcome.why), `${name} failed for another reason: ${outcome.why}`).toBe(true);
		expect(runtime.definitions.get(name)?.definition.sessionBound === true, name).toBe(!outcome.ran);
	}
	const bound = [...outcomes].filter(([, outcome]) => !outcome.ran).map(([name]) => name);
	expect(bound).toContain("todo");
	expect(bound).not.toContain("bash");
	expect(bound).not.toContain("monitor");
}, 60_000);
