import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { parseHookConfig } from "../../src/core/extensions/builtin/hooks/index.ts";
import { createHookTrustEntry, hookTrustId } from "../../src/core/extensions/builtin/hooks/trust.ts";
import type { HookSourceMetadata, HookTrustEntry } from "../../src/core/extensions/builtin/hooks/types.ts";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import { createHarness } from "../suite/harness.ts";
import { resultText, sessionExecutor } from "./executor-harness.ts";

// R23.a: the user's PreToolUse and PostToolUse command hooks run on the executor, once each per execution.
type Mode = "allow" | "deny" | "replace";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

const HOOK_SCRIPT = `import { appendFileSync } from "node:fs";
const [tracePath, event, mode] = process.argv.slice(2);
process.stdin.resume();
process.stdin.on("end", () => {
	appendFileSync(tracePath, event + "\\n");
	const out = { hookEventName: event };
	if (event === "PreToolUse" && mode === "deny") Object.assign(out, { permissionDecision: "deny", permissionDecisionReason: "denied on the hand" });
	if (event === "PostToolUse" && mode === "replace") Object.assign(out, { updatedToolOutput: "replaced on the hand" });
	process.stdout.write(JSON.stringify({ hookSpecificOutput: out }));
});
`;

function writeTrustedHooks(cwd: string, command: (event: string) => string): void {
	const senpiDir = join(cwd, ".senpi");
	mkdirSync(senpiDir, { recursive: true });
	const sourcePath = join(senpiDir, "hooks.json");
	const entry = (event: string) => [{ matcher: "echo", hooks: [{ type: "command", command: command(event) }] }];
	const hookConfig = { hooks: { PreToolUse: entry("PreToolUse"), PostToolUse: entry("PostToolUse") } };
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
			updatedAt: "2026-11-02T00:00:00.000Z",
		});
	}
	writeFileSync(join(senpiDir, "hooks-state.json"), `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`, "utf-8");
}

async function openHookedExecutor(mode: Mode) {
	const hookDir = mkdtempSync(join(tmpdir(), "senpi-r23a-"));
	const tracePath = join(hookDir, "trace.log");
	const scriptPath = join(hookDir, "hook.mjs");
	writeFileSync(scriptPath, HOOK_SCRIPT);
	const echo: AgentTool = {
		name: "echo",
		label: "echo",
		description: "Echo text back",
		parameters: Type.Object({ text: Type.String() }),
		execute: async (_id, params) => {
			const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
			appendFileSync(tracePath, `body(${text})\n`);
			return { content: [{ type: "text", text: `tool:${text}` }], details: {} };
		},
	};
	const hooks = builtinExtensions.find((entry) => entry.id === "hooks");
	if (hooks === undefined) throw new Error("builtin hooks extension is not registered");
	const harness = await createHarness({
		tools: [echo],
		extensionFactories: [{ factory: hooks.factory, path: "<builtin:hooks>" }],
	});
	cleanups.push(() => {
		harness.cleanup();
		rmSync(hookDir, { recursive: true, force: true });
	});
	writeTrustedHooks(harness.tempDir, (event) =>
		[process.execPath, scriptPath, tracePath, event, mode].map((arg) => JSON.stringify(arg)).join(" "),
	);
	const executor = await sessionExecutor(harness.session);
	const trace = () => (existsSync(tracePath) ? readFileSync(tracePath, "utf-8").split("\n").filter(Boolean) : []);
	return { executor, trace };
}

describe("R23.a: tool hooks run on the executor", () => {
	it("runs PreToolUse before the body and PostToolUse after it, once each, across re-sent prepare and release", async () => {
		// Given
		const { executor, trace } = await openHookedExecutor("allow");

		// When
		const prepared = await executor.prepare("r23a", "echo", { text: "hi" });
		const resent = await executor.prepare("r23a", "echo", { text: "hi" });
		const released = await executor.release("r23a");
		const again = await executor.release("r23a");

		// Then
		expect(resent).toEqual(prepared);
		expect(released.kind === "settled" && resultText(released.result)).toBe("tool:hi");
		expect(again.kind).toBe("replayed");
		expect(trace()).toEqual(["PreToolUse", "body(hi)", "PostToolUse"]);
	}, 30_000);

	it("applies the PostToolUse result on the executor", async () => {
		// Given
		const { executor, trace } = await openHookedExecutor("replace");

		// When
		await executor.prepare("r23a-post", "echo", { text: "secret" });
		const released = await executor.release("r23a-post");

		// Then
		expect(released.kind === "settled" && resultText(released.result)).toContain("replaced on the hand");
		expect(released.kind === "settled" && resultText(released.result)).not.toContain("tool:secret");
		expect(trace()).toEqual(["PreToolUse", "body(secret)", "PostToolUse"]);
	}, 30_000);

	it("blocks on a PreToolUse deny with no body and no PostToolUse", async () => {
		// Given
		const { executor, trace } = await openHookedExecutor("deny");

		// When
		const prepared = await executor.prepare("r23a-deny", "echo", { text: "rm" });
		const released = await executor.release("r23a-deny");

		// Then
		expect(prepared.kind === "blocked" && resultText(prepared.result)).toContain("denied on the hand");
		expect(released).toEqual({ kind: "refused", reason: "blocked" });
		expect(trace()).toEqual(["PreToolUse"]);
	}, 30_000);
});
