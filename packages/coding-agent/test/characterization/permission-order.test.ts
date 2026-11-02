import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { parseHookConfig } from "../../src/core/extensions/builtin/hooks/index.ts";
import { createHookTrustEntry, hookTrustId } from "../../src/core/extensions/builtin/hooks/trust.ts";
import type { HookSourceMetadata, HookTrustEntry } from "../../src/core/extensions/builtin/hooks/types.ts";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import { createBashTool } from "../../src/core/tools/bash.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "../suite/harness.ts";

// X1 (plan P0-02c): today's order between the builtin shell-hooks extension (PreToolUse) and the builtin
// permission system for one tool call. Both extensions load in their builtin registration order, so the pins
// below follow whatever order `builtinExtensions` declares.

const ORDERED_IDS = ["hooks", "permission-system"];
const NOTES = "keep me\n";

type HookMode = "deny" | "allow" | "rewrite";

const harnesses: Harness[] = [];
const dirs: string[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function orderedExtensions() {
	return builtinExtensions
		.filter((entry) => ORDERED_IDS.includes(entry.id))
		.map((entry) => ({ factory: entry.factory, path: `<builtin:${entry.id}>` }));
}

// The PreToolUse command: appends "pre" to the trace, then answers per mode. "rewrite" swaps the command for
// argv[4] through `updatedInput`.
const HOOK_SCRIPT = `import { appendFileSync } from "node:fs";
const [tracePath, mode, rewritten] = process.argv.slice(2);
process.stdin.resume();
process.stdin.on("end", () => {
	appendFileSync(tracePath, "pre\\n");
	const out = { hookEventName: "PreToolUse" };
	if (mode === "deny") Object.assign(out, { permissionDecision: "deny", permissionDecisionReason: "X1 hook denied" });
	if (mode === "allow") Object.assign(out, { permissionDecision: "allow" });
	if (mode === "rewrite") Object.assign(out, { permissionDecision: "allow", updatedInput: { command: rewritten } });
	process.stdout.write(JSON.stringify({ hookSpecificOutput: out }));
});
`;

function writeTrustedBashHook(cwd: string, command: string): void {
	const senpiDir = join(cwd, ".senpi");
	mkdirSync(senpiDir, { recursive: true });
	const sourcePath = join(senpiDir, "hooks.json");
	const hookConfig = { hooks: { PreToolUse: [{ matcher: "bash", hooks: [{ type: "command", command }] }] } };
	writeFileSync(sourcePath, `${JSON.stringify(hookConfig, null, 2)}\n`, "utf-8");
	const source = {
		discoveredAt: "pre-session",
		displayOrder: 0,
		scope: "project",
		sourcePath,
	} satisfies HookSourceMetadata;
	const hooks: Record<string, HookTrustEntry> = {};
	for (const handler of parseHookConfig(hookConfig, source).executableHandlers) {
		hooks[hookTrustId(handler)] = createHookTrustEntry(handler, {
			platform: process.platform,
			updatedAt: "2026-10-27T00:00:00.000Z",
		});
	}
	writeFileSync(join(senpiDir, "hooks-state.json"), `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`, "utf-8");
}

interface RunOptions {
	readonly mode: HookMode;
	readonly command: string;
	readonly rewrittenCommand?: string;
}

async function runAutoPresetBashCall(options: RunOptions) {
	const projectDir = mkdtempSync(join(tmpdir(), "senpi-x1-project-"));
	const hookDir = mkdtempSync(join(tmpdir(), "senpi-x1-hook-"));
	dirs.push(projectDir, hookDir);
	const notesPath = join(projectDir, "notes.txt");
	writeFileSync(notesPath, NOTES);
	const tracePath = join(hookDir, "trace.log");
	const scriptPath = join(hookDir, "pre-tool-use.mjs");
	writeFileSync(scriptPath, HOOK_SCRIPT);
	const args = [process.execPath, scriptPath, tracePath, options.mode, options.rewrittenCommand ?? ""];
	writeTrustedBashHook(projectDir, args.map((arg) => JSON.stringify(arg)).join(" "));
	const harness = await createHarness({
		cwd: projectDir,
		tools: [createBashTool(projectDir)],
		extensionFactories: orderedExtensions(),
		extensionFlagValues: new Map([["permission-preset", "auto"]]),
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command: options.command }), { stopReason: "toolUse" }),
		fauxAssistantMessage("continued"),
	]);

	await harness.session.prompt("tidy up");

	return {
		result: getMessageText(getToolResult(harness, "bash")),
		trace: existsSync(tracePath) ? readFileSync(tracePath, "utf-8").split("\n").filter(Boolean) : [],
		notes: existsSync(notesPath) ? readFileSync(notesPath, "utf-8") : undefined,
	};
}

describe("X1: permission vs PreToolUse order", () => {
	it("registers the shell hooks extension ahead of the permission system", () => {
		// Given / When
		const ids = builtinExtensions.map((entry) => entry.id);

		// Then
		expect(ids.indexOf("hooks")).toBeGreaterThanOrEqual(0);
		expect(ids.indexOf("hooks")).toBeLessThan(ids.indexOf("permission-system"));
		expect(orderedExtensions().map((entry) => entry.path)).toEqual([
			"<builtin:hooks>",
			"<builtin:permission-system>",
		]);
	});

	it("runs a call that both the hook and the auto preset allow", async () => {
		// Given an auto session and a hook that allows; When the agent reads a project file.
		const run = await runAutoPresetBashCall({ mode: "allow", command: "cat notes.txt" });

		// Then the hook ran once and the read went through.
		expect(run.trace).toEqual(["pre"]);
		expect(run.result).toContain("keep me");
		expect(run.notes).toBe(NOTES);
	}, 30_000);

	it("lets a PreToolUse deny refuse the call before the permission system is consulted", async () => {
		// Given an auto session (which asks for `rm`, and refuses with no UI) and a hook that denies.
		// When the agent deletes a project file.
		const run = await runAutoPresetBashCall({ mode: "deny", command: "rm notes.txt" });

		// Then the hook's reason is the refusal, not the permission system's, and the file stays.
		expect(run.trace).toEqual(["pre"]);
		expect(run.result).toContain("X1 hook denied");
		expect(run.result).not.toContain("Permission required");
		expect(run.notes).toBe(NOTES);
	}, 30_000);

	it("still consults the permission system after a PreToolUse allow", async () => {
		// Given an auto session and a hook that answers permissionDecision "allow".
		// When the agent deletes a project file.
		const run = await runAutoPresetBashCall({ mode: "allow", command: "rm notes.txt" });

		// Then the hook ran first, its allow did not skip the permission system, which refuses; the file stays.
		expect(run.trace).toEqual(["pre"]);
		expect(run.result).toContain("Permission required for bash");
		expect(run.notes).toBe(NOTES);
	}, 30_000);

	it("judges the hook's rewritten input in the permission system", async () => {
		// Given an auto session and a hook that rewrites an allowed read into a delete.
		// When the agent reads a project file.
		const run = await runAutoPresetBashCall({
			mode: "rewrite",
			command: "cat notes.txt",
			rewrittenCommand: "rm notes.txt",
		});

		// Then the permission system judged the delete and refused it; the file stays.
		expect(run.trace).toEqual(["pre"]);
		expect(run.result).toContain("Permission required for bash");
		expect(run.notes).toBe(NOTES);
	}, 30_000);
});
