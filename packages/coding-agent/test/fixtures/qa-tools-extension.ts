/**
 * QA fixture tools for the tool-child runtime (senpi#3566 todo 5). Load with `--extension` (the QA
 * driver does). `QA_TOOL_PLACEMENTS` names where each tool belongs once the generic dispatcher lands:
 * everything runs in the session's tool child except `qa_blob_server`. The control directory is
 * `SENPI_TOOL_CHILD_TEST_CONTROL_DIR`; `SENPI_TOOL_CHILD_TEST_SUSPEND_WRITE` suspends `qa_mutate`.
 */
import { createHash } from "node:crypto";
import { appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type TSchema, Type } from "typebox";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "../../src/core/extensions/types.ts";
import { fileCreated } from "./qa-tools/file-created.ts";
import { spawnFixture } from "./qa-tools/spawn-fixture.ts";

type QaToolName =
	| "qa_sleep"
	| "qa_blob"
	| "qa_blob_server"
	| "qa_sink"
	| "qa_hostcall"
	| "qa_spawn"
	| "qa_mutate"
	| "qa_segv";

export const QA_TOOL_PLACEMENTS: Readonly<Record<QaToolName, "child" | "server">> = {
	qa_sleep: "child",
	qa_blob: "child",
	qa_blob_server: "server",
	qa_sink: "child",
	qa_hostcall: "child",
	qa_spawn: "child",
	qa_mutate: "child",
	qa_segv: "child",
};

export interface SegvDeps {
	readonly kill: (pid: number, signal: NodeJS.Signals) => unknown;
	readonly exit: (code: number) => unknown;
	readonly platform: NodeJS.Platform;
}

const WINDOWS_ACCESS_VIOLATION = 0xc0000005;
/** Tools with a body in `qa-tools/child-bodies.ts` (all child-placed ones). */
const CHILD_BODIES: ReadonlySet<QaToolName> = new Set([
	"qa_hostcall",
	"qa_sleep",
	"qa_blob",
	"qa_sink",
	"qa_spawn",
	"qa_mutate",
	"qa_segv",
]);
const controlDirOf = (): string => process.env.SENPI_TOOL_CHILD_TEST_CONTROL_DIR ?? tmpdir();

export function blobText(bytes: number): string {
	return "b".repeat(bytes);
}

export function sinkDigest(payload: string): string {
	return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** `args` with `fill.field` set to `fill.bytes` of text, built where the call is made (not carried by the model). */
export function hostcallArgs(params: {
	readonly args: unknown;
	readonly fill?: { readonly field: string; readonly bytes: number };
}): unknown {
	if (params.fill === undefined) return params.args;
	const base = typeof params.args === "object" && params.args !== null ? params.args : {};
	return { ...base, [params.fill.field]: "s".repeat(params.fill.bytes) };
}

export async function runHostcalls(
	params: { readonly tool: string; readonly args: unknown; readonly count: number },
	execute: (tool: string, args: unknown) => Promise<{ isError: boolean; text: string }>,
): Promise<{ index: number; isError: boolean; text: string }[]> {
	const outcomes: { index: number; isError: boolean; text: string }[] = [];
	for (let index = 0; index < params.count; index++) {
		const outcome = await execute(params.tool, params.args);
		outcomes.push({ index, isError: outcome.isError, text: outcome.text });
	}
	return outcomes;
}

export function raiseSegv(deps: SegvDeps): void {
	if (deps.platform === "win32") deps.exit(WINDOWS_ACCESS_VIOLATION);
	else deps.kill(process.pid, "SIGSEGV");
}

export async function mutateFile(
	params: { readonly path: string; readonly line: string },
	options: { readonly suspend: boolean; readonly controlDir: string },
): Promise<void> {
	if (options.suspend) {
		const released = fileCreated(options.controlDir, "release-write");
		await writeFile(join(options.controlDir, "write-suspended"), params.path);
		await released;
	}
	await appendFile(params.path, `${params.line}\n`);
}

function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
	return result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

function tool<P extends TSchema>(
	name: QaToolName,
	parameters: P,
	run: (
		params: Parameters<ToolDefinition<P>["execute"]>[1],
		ctx: ExtensionToolContext,
		toolCallId: string,
		signal?: AbortSignal,
	) => Promise<{ text: string; details: unknown }>,
): ToolDefinition<P> {
	return {
		name,
		label: name,
		description: `QA fixture tool ${name} (placement: ${QA_TOOL_PLACEMENTS[name]})`,
		placement: QA_TOOL_PLACEMENTS[name],
		...(CHILD_BODIES.has(name) ? { childModule: { path: "./qa-tools/child-bodies.ts", export: name } } : {}),
		parameters,
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const { text, details } = await run(params, ctx, toolCallId, signal);
			return { content: [{ type: "text", text }], details };
		},
	};
}

const PROCESS_SEGV: SegvDeps = {
	kill: (pid, signal) => process.kill(pid, signal),
	exit: (code) => process.exit(code),
	platform: process.platform,
};

export function createQaTools(segv: SegvDeps = PROCESS_SEGV): ToolDefinition[] {
	const bytes = Type.Object({ bytes: Type.Integer({ minimum: 0 }) });
	const blob = async (params: { bytes: number }) => ({
		text: blobText(params.bytes),
		details: { bytes: params.bytes },
	});
	return [
		tool("qa_sleep", Type.Object({ ms: Type.Integer({ minimum: 0 }) }), async (params, _ctx, _id, signal) => {
			await delay(params.ms, undefined, { signal });
			return { text: `slept ${params.ms}ms`, details: { ms: params.ms } };
		}),
		tool("qa_blob", bytes, blob),
		tool("qa_blob_server", bytes, blob),
		tool("qa_sink", Type.Object({ payload: Type.String() }), async (params) => {
			const digest = sinkDigest(params.payload);
			return { text: digest, details: { sha256: digest, bytes: Buffer.byteLength(params.payload, "utf8") } };
		}),
		tool(
			"qa_hostcall",
			Type.Object({
				tool: Type.String(),
				args: Type.Unknown(),
				count: Type.Integer({ minimum: 1 }),
				fill: Type.Optional(Type.Object({ field: Type.String(), bytes: Type.Integer({ minimum: 0 }) })),
			}),
			async (params, ctx) => {
				const outcomes = await runHostcalls({ ...params, args: hostcallArgs(params) }, async (name, args) => {
					const outcome = await ctx.executeTool(name, args);
					return { isError: outcome.isError, text: textOf(outcome.result) };
				});
				return {
					text: JSON.stringify(outcomes.map(({ index, isError }) => ({ index, isError }))),
					details: { outcomes },
				};
			},
		),
		tool(
			"qa_spawn",
			Type.Object({
				api: Type.Union(
					["bun.spawn", "bun.spawnSync", "bun.shell", "cp.spawn", "cp.spawnSync", "cp.execFileSync"].map((api) =>
						Type.Literal(api),
					),
				),
				argv: Type.Array(Type.String(), { minItems: 1 }),
				detached: Type.Optional(Type.Boolean()),
				viaShell: Type.Optional(Type.Boolean()),
				gate: Type.Optional(Type.Boolean()),
			}),
			async (params, _ctx, toolCallId) => {
				const launchId = toolCallId.replace(/[^A-Za-z0-9_-]/g, "_");
				const result = await spawnFixture(params, { controlDir: controlDirOf(), launchId });
				return { text: JSON.stringify(result), details: { launchId, ...result } };
			},
		),
		tool("qa_mutate", Type.Object({ path: Type.String(), line: Type.String() }), async (params) => {
			const suspend = process.env.SENPI_TOOL_CHILD_TEST_SUSPEND_WRITE !== undefined;
			await mutateFile(params, { suspend, controlDir: controlDirOf() });
			return { text: `appended to ${params.path}`, details: { suspended: suspend } };
		}),
		tool("qa_segv", Type.Object({}), async () => {
			raiseSegv(segv);
			return { text: "qa_segv returned without terminating", details: {} };
		}),
	];
}

export default function qaToolsExtension(pi: ExtensionAPI): void {
	for (const definition of createQaTools()) pi.registerTool(definition);
}
