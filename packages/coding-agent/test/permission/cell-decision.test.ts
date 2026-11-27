import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	cellEnforcementState,
	type CellOperation,
	decideCellOperation,
	onCellEnforcementChange,
} from "../../src/core/extensions/builtin/permission-system/cell-decision.ts";
import { authorizeToolDispatch } from "../../src/core/extensions/builtin/permission-system/dispatch.ts";
import permissionSystemExtension from "../../src/core/extensions/builtin/permission-system/index.ts";
import { createHarness } from "../suite/harness.ts";

const harnesses: Awaited<ReturnType<typeof createHarness>>[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function fixture(rules = "", preset = "full-access", settingsContent?: string) {
	const asked = vi.fn();
	const harness = await createHarness({
		...(settingsContent === undefined ? {} : { fileSettings: true, settingsContent }),
		extensionFlagValues: new Map([
			["permission", rules],
			["permission-preset", preset],
		]),
		extensionFactories: [
			permissionSystemExtension,
			(pi) => {
				pi.events.on("permission_asked", asked);
			},
		],
	});
	harnesses.push(harness);
	const runner = harness.getExtensionRunner();
	await runner.emit({ type: "session_start", reason: "startup" });
	const ctx = runner.createContext();
	const session = ctx.sessionManager;
	return { harness, runner, ctx, session, asked };
}

// senpi#4309: cell decisions must preserve the tool path's per-pattern deny projection.
it.each([
	{
		rules: "read:secret.txt=deny,read:/project/*=allow",
		tool: "read" as const,
		input: { path: "secret.txt" },
		denied: true,
	},
	{ rules: "bash:*=deny,bash:git *=allow", tool: "bash" as const, input: { command: "uname" }, denied: true },
	{ rules: "bash:*=deny,bash:git *=allow", tool: "bash" as const, input: { command: "git status" }, denied: false },
	{
		rules: "bash:uname=deny",
		tool: "bash" as const,
		input: { command: "git status; uname" },
		denied: true,
	},
	{
		rules: "external_directory:*=deny",
		tool: "write" as const,
		input: { path: "../outside.txt" },
		denied: true,
	},
])("matches tool denial for $rules / $input", async ({ rules, tool, input, denied }) => {
	const fx = await fixture(rules);
	const call: CellOperation = { tool, input, cwd: fx.ctx.cwd };
	const direct = await fx.runner.emitToolCall({
		type: "tool_call",
		toolCallId: "parity",
		toolName: tool,
		input,
	});
	expect(direct?.block === true).toBe(denied);
	expect((await decideCellOperation(fx.session, call)).action === "deny").toBe(denied);
});

it.each([
	{ rules: "external_directory:*=deny", nested: false, denied: false },
	{ rules: "external_directory:*=deny", nested: true, denied: true },
	// Deliberate no-deny controls: they pin that the cwd row never refuses without a rule; they cannot detect a cwd regression.
	{ rules: "", nested: false, denied: false },
	{ rules: "", nested: true, denied: false },
])(
	"uses the execution cwd for external directory classification: $rules / nested=$nested",
	async ({ rules, nested, denied }) => {
		const fx = await fixture(rules);
		const call: CellOperation = {
			tool: "write",
			input: { path: join(fx.ctx.cwd, "inside.txt") },
			cwd: nested ? join(fx.ctx.cwd, "other") : fx.ctx.cwd,
		};
		vi.spyOn(fx.runner, "createContext").mockReturnValue({ ...fx.ctx, cwd: call.cwd });
		const direct = await fx.runner.emitToolCall({
			type: "tool_call",
			toolCallId: "cwd",
			toolName: call.tool,
			input: call.input,
		});
		expect(direct?.block === true).toBe(denied);
		expect((await decideCellOperation(fx.session, call)).action === "deny").toBe(denied);
	},
);

it("returns the deciding rule and its layer", async () => {
	const fx = await fixture("read:secret.txt=deny");
	expect(
		await decideCellOperation(fx.session, { tool: "read", input: { path: "secret.txt" }, cwd: fx.ctx.cwd }),
	).toEqual({
		action: "deny",
		rule: { permission: "read", pattern: "secret.txt", layer: "cli" },
	});
});

it("publishes epochs for ordered user rule changes only while a deny applies", async () => {
	const fx = await fixture();
	const initial = cellEnforcementState(fx.session);
	expect(initial).toMatchObject({ alive: true, active: false });
	const changed = vi.fn();
	const unsubscribe = onCellEnforcementChange(fx.session, changed);
	fx.runner.setFlagValue("permission", "bash:git *=allow");
	expect(cellEnforcementState(fx.session).epoch).toBe(initial.epoch);
	fx.runner.setFlagValue("permission", "bash:*=deny,bash:git *=allow");
	const added = cellEnforcementState(fx.session);
	expect(added).toEqual({ alive: true, active: true, epoch: initial.epoch + 1 });
	fx.runner.setFlagValue("permission", "bash:*=deny");
	expect(cellEnforcementState(fx.session).epoch).toBe(added.epoch + 1);
	fx.runner.setFlagValue("permission-preset", "ask");
	expect(cellEnforcementState(fx.session).epoch).toBe(added.epoch + 2);
	fx.runner.setFlagValue("permission", "");
	expect(cellEnforcementState(fx.session)).toEqual({ alive: true, active: false, epoch: added.epoch + 3 });
	expect(changed).toHaveBeenCalledTimes(4);
	unsubscribe();
	await fx.runner.emit({ type: "session_shutdown", reason: "quit" });
	expect(changed).toHaveBeenCalledTimes(4);
	expect(cellEnforcementState(fx.session).alive).toBe(false);
});

it.each(["full-access", "ask"])("never asks for cell operations under %s", async (preset) => {
	const fx = await fixture("read:secret.txt=deny", preset);
	expect(
		await decideCellOperation(fx.session, { tool: "bash", input: { command: "uname" }, cwd: fx.ctx.cwd }),
	).toEqual({
		action: "pass",
	});
	expect(
		(await decideCellOperation(fx.session, { tool: "read", input: { path: "secret.txt" }, cwd: fx.ctx.cwd })).action,
	).toBe("deny");
	expect(fx.asked).not.toHaveBeenCalled();
});

it("fails closed without registration and after shutdown", async () => {
	expect(await decideCellOperation({}, { tool: "ls", input: { path: "." }, cwd: "/project" })).toMatchObject({
		action: "deny",
		rule: { permission: "permission_authority", pattern: "unavailable", layer: "system" },
	});
	const fx = await fixture();
	await fx.runner.emit({ type: "session_shutdown", reason: "quit" });
	expect((await decideCellOperation(fx.session, { tool: "ls", input: {}, cwd: fx.ctx.cwd })).action).toBe("deny");
});

it.each(
	["", "read:*=deny"].flatMap((rules) =>
		["preset", "rules"].flatMap((failure) =>
			["state", "cell", "tool", "dispatch"].map((entry) => ({ rules, failure, entry })),
		),
	),
)("publishes failed reload and recovery: $rules / $failure / $entry", async ({ rules, failure, entry }) => {
	const fx = await fixture(rules, "full-access", "{}");
	const initial = cellEnforcementState(fx.session);
	const changed = vi.fn();
	const unsubscribe = onCellEnforcementChange(fx.session, changed);
	const call: CellOperation = { tool: "bash", input: { command: "uname" }, cwd: fx.ctx.cwd };
	if (failure === "preset") {
		fx.runner.setFlagValue("permission-preset", "invalid");
	} else {
		writeFileSync(join(fx.ctx.agentDir, "settings.json"), JSON.stringify({ permission: { read: null } }));
	}
	fx.runner.setFlagValue("permission", `${rules},bash:git *=allow`);
	if (entry === "state") cellEnforcementState(fx.session);
	else if (entry === "cell") await decideCellOperation(fx.session, call);
	else if (entry === "tool") {
		expect(
			await fx.runner.emitToolCall({
				type: "tool_call",
				toolCallId: "failed-reload",
				toolName: call.tool,
				input: call.input,
			}),
		).toMatchObject({ block: true });
	} else {
		await expect(
			authorizeToolDispatch(
				fx.session,
				{
					toolCallId: "failed-reload",
					toolName: call.tool,
					input: call.input,
					identity: { owner: {}, metadata: "reload" },
				},
				fx.ctx,
				undefined,
			),
		).rejects.toThrow();
	}
	const failed = { alive: true, active: true, epoch: initial.epoch + 1 };
	expect(changed).toHaveBeenCalledExactlyOnceWith(failed);
	expect(cellEnforcementState(fx.session)).toEqual(failed);
	expect(await decideCellOperation(fx.session, call)).toEqual({
		action: "deny",
		rule: { permission: "permission_authority", pattern: "setup_failed", layer: "system" },
	});
	expect(changed).toHaveBeenCalledTimes(1);

	writeFileSync(join(fx.ctx.agentDir, "settings.json"), "{}");
	fx.runner.setFlagValue("permission-preset", "full-access");
	fx.runner.setFlagValue("permission", rules);
	expect(await decideCellOperation(fx.session, call)).toEqual({ action: "pass" });
	expect(cellEnforcementState(fx.session)).toEqual({ ...initial, epoch: initial.epoch + 2 });
	expect(changed).toHaveBeenCalledTimes(2);
	expect(changed).toHaveBeenLastCalledWith({ ...initial, epoch: initial.epoch + 2 });
	unsubscribe();
});

it.each(["preset", "rules"])("activates enforcement for failed initial %s setup", async (failure) => {
	const fx = await fixture(
		"",
		failure === "preset" ? "invalid" : "full-access",
		failure === "rules" ? JSON.stringify({ permission: { read: null } }) : undefined,
	);
	expect(cellEnforcementState(fx.session)).toEqual({ alive: true, active: true, epoch: 1 });
	expect(await decideCellOperation(fx.session, { tool: "ls", input: {}, cwd: fx.ctx.cwd })).toMatchObject({
		action: "deny",
		rule: { pattern: "setup_failed" },
	});
});

it.each([
	{ rules: "", next: "read:*=deny", preset: "full-access" },
	{ rules: "read:*=deny", next: "", preset: "full-access" },
	{ rules: "read:*=deny", next: "read:secret.txt=deny", preset: "full-access" },
	{ rules: "", next: "bash:git *=deny", preset: "full-access" },
	{ rules: "", next: "", preset: "invalid" },
])("keeps retired state stable: $rules -> $next / $preset", async ({ rules, next, preset }) => {
	const fx = await fixture(rules);
	const changed = vi.fn();
	const unsubscribe = onCellEnforcementChange(fx.session, changed);
	await fx.runner.emit({ type: "session_shutdown", reason: "quit" });
	const retired = cellEnforcementState(fx.session);
	expect(retired.alive).toBe(false);
	expect(changed).toHaveBeenCalledExactlyOnceWith(retired);
	fx.runner.setFlagValue("permission", next);
	fx.runner.setFlagValue("permission-preset", preset);
	await fx.runner.emitToolCall({
		type: "tool_call",
		toolCallId: "after-retirement",
		toolName: "read",
		input: { path: "secret.txt" },
	});
	expect(cellEnforcementState(fx.session)).toEqual(retired);
	expect(changed).toHaveBeenCalledTimes(1);
	expect(await decideCellOperation(fx.session, { tool: "read", input: {}, cwd: fx.ctx.cwd })).toMatchObject({
		action: "deny",
		rule: { pattern: "unavailable" },
	});
	unsubscribe();
	fx.runner.setFlagValue("permission-preset", "full-access");
	await fx.runner.emit({ type: "session_start", reason: "startup" });
	expect(cellEnforcementState(fx.session)).toMatchObject({ alive: true, active: next.includes("deny") });
});
