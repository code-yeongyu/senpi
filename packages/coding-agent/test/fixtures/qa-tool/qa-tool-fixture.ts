import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Static, Type } from "typebox";
import { parseHookConfig } from "../../../src/core/extensions/builtin/hooks/index.ts";
import { createHookTrustEntry, hookTrustId } from "../../../src/core/extensions/builtin/hooks/trust.ts";
import type { HookSourceMetadata, HookTrustEntry } from "../../../src/core/extensions/builtin/hooks/types.ts";
import { builtinExtensions } from "../../../src/core/extensions/builtin/index.ts";
import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "../../../src/index.ts";

// The G1 fixture: an inactive search-exposed `qa` tool whose shim turns `{legacy:"42"}` into `{value:42}`, a lazy
// activator, a first `tool_call` handler (hook1), the builtin shell-hooks extension (one PreToolUse command), and a
// second `tool_call` handler (hook2). Every step appends one line to a trace file, so in-process steps and the shell
// hook land in one ordered record.

const QaParameters = Type.Object({ value: Type.Number() });
type QaArgs = Static<typeof QaParameters>;

const hookScriptPath = fileURLToPath(new URL("./pre-tool-use-hook.mjs", import.meta.url));

interface QaToolFixture {
	readonly extensionFactories: Array<ExtensionFactory | { factory: ExtensionFactory; path: string }>;
	readonly handlerValueTypes: string[];
	api(): ExtensionAPI;
	readTrace(): string[];
	readPreToolUseStdin(): unknown;
	trustPreToolUseHook(cwd: string): void;
	cleanup(): void;
}

function hooksExtensionFactory(): ExtensionFactory {
	const extension = builtinExtensions.find((entry) => entry.id === "hooks");
	if (extension === undefined) throw new Error("builtin hooks extension is not registered");
	return extension.factory;
}

function legacyShim(record: (entry: string) => void) {
	return (args: unknown): QaArgs => {
		record("shim");
		if (typeof args === "object" && args !== null && "legacy" in args) {
			return { value: Number(args.legacy) };
		}
		// A shim runs before validation: anything else passes through for the schema check to judge.
		return args as QaArgs;
	};
}

function qaTool(record: (entry: string) => void): ToolDefinition<typeof QaParameters> {
	return {
		name: "qa",
		label: "qa",
		description: "G1 characterization tool",
		exposure: "search",
		parameters: QaParameters,
		prepareArguments: legacyShim(record),
		execute: async (_toolCallId, params) => {
			record(`body(${params.value})`);
			return { content: [{ type: "text" as const, text: `qa:${params.value}` }], details: {} };
		},
	};
}

function inputValueType(input: object): string {
	return "value" in input ? typeof input.value : "missing";
}

function writeTrustedPreToolUseHook(cwd: string, command: string): void {
	const senpiDir = join(cwd, ".senpi");
	mkdirSync(senpiDir, { recursive: true });
	const sourcePath = join(senpiDir, "hooks.json");
	const hookConfig = { hooks: { PreToolUse: [{ matcher: "qa", hooks: [{ type: "command", command }] }] } };
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

export function createQaToolFixture(): QaToolFixture {
	const traceDir = mkdtempSync(join(tmpdir(), "senpi-g1-trace-"));
	const tracePath = join(traceDir, "trace.log");
	const record = (entry: string) => appendFileSync(tracePath, `${entry}\n`);
	const handlerValueTypes: string[] = [];
	let capturedApi: ExtensionAPI | undefined;

	const qaExtension: ExtensionFactory = (pi) => {
		capturedApi = pi;
		pi.registerTool(qaTool(record));
		pi.registerLazyToolActivator((toolName) => {
			if (toolName !== "qa") return false;
			record("activate");
			pi.setActiveTools([...pi.getActiveTools(), toolName]);
			return true;
		});
		pi.on("tool_call", (event) => {
			record("hook1");
			handlerValueTypes.push(inputValueType(event.input));
		});
	};
	const secondHandlerExtension: ExtensionFactory = (pi) => {
		pi.on("tool_call", (event) => {
			record("hook2");
			handlerValueTypes.push(inputValueType(event.input));
		});
	};

	return {
		extensionFactories: [
			qaExtension,
			{ factory: hooksExtensionFactory(), path: "<builtin:hooks>" },
			secondHandlerExtension,
		],
		handlerValueTypes,
		api() {
			if (capturedApi === undefined) throw new Error("the qa fixture extension was not loaded");
			return capturedApi;
		},
		readTrace() {
			if (!existsSync(tracePath)) return [];
			return readFileSync(tracePath, "utf-8").split("\n").filter(Boolean);
		},
		readPreToolUseStdin() {
			return JSON.parse(readFileSync(`${tracePath}.pre-stdin.json`, "utf-8"));
		},
		trustPreToolUseHook(cwd) {
			writeTrustedPreToolUseHook(
				cwd,
				`${JSON.stringify(process.execPath)} ${JSON.stringify(hookScriptPath)} ${JSON.stringify(tracePath)}`,
			);
		},
		cleanup() {
			rmSync(traceDir, { recursive: true, force: true });
		},
	};
}
