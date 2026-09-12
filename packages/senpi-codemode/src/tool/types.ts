import type { AgentToolResult, AgentToolUpdateCallback } from "@code-yeongyu/senpi";
import { type TSchema, type TUnsafe, Type } from "typebox";
import type { HostToKernelMessage, KernelToHostMessage } from "../bridge/protocol.ts";
import {
	DEFAULT_FOREGROUND_WINDOW_SECONDS,
	DEFAULT_HARD_LIMIT_SECONDS,
	DEFAULT_RUN_BUDGET_SECONDS,
	defaultCodemodeSettings,
} from "../config/settings.ts";
import type { TruncationMeta } from "../output/output-meta.ts";

export const evalLanguageOrder = ["js", "py", "rb", "jl"] as const;
export type EvalLanguage = (typeof evalLanguageOrder)[number];
export type EnabledEvalLanguages = Readonly<Record<EvalLanguage, boolean>>;

export function enabledLanguageList(enabled: EnabledEvalLanguages): EvalLanguage[] {
	return evalLanguageOrder.filter((language) => enabled[language]);
}

export const EVAL_SUMMARY_MAX_LENGTH = 80;

const LANGUAGE_FIELD_DESCRIPTION =
	"REQUIRED for run. Choose a kernel explicitly; there is no default. Omit for peek/stop.";

/** The deadlines the schema teaches the model; every number comes from the resolved settings. */
export interface EvalDeadlineSeconds {
	readonly runBudgetSeconds: number;
	/** Effective interactive detach point: `cellTimeoutSeconds` capped by the foreground window. */
	readonly detachAfterSeconds: number;
	/** Longest a host tool call can hold an interactive call before it detaches anyway. */
	readonly foregroundWindowSeconds: number;
	readonly hardLimitSeconds: number;
}

export const defaultEvalDeadlineSeconds: EvalDeadlineSeconds = {
	runBudgetSeconds: DEFAULT_RUN_BUDGET_SECONDS,
	detachAfterSeconds: Math.min(defaultCodemodeSettings.cellTimeoutSeconds, DEFAULT_FOREGROUND_WINDOW_SECONDS),
	foregroundWindowSeconds: DEFAULT_FOREGROUND_WINDOW_SECONDS,
	hardLimitSeconds: DEFAULT_HARD_LIMIT_SECONDS,
};

function timeoutFieldDescription(deadlines: EvalDeadlineSeconds): string {
	return `Run budget in seconds for this cell's own execution (default ${deadlines.runBudgetSeconds}s); time parked in host tool calls such as agent() or tool.* is not charged. When it runs out the cell is killed, and a js cell that cannot settle (a pending timer or Bun.$ command, a synchronous call) restarts its kernel and loses every global. Raise it only for a declared long run; a value above ${deadlines.hardLimitSeconds}s also raises the wall-clock hard limit. It does not move the detach point.`;
}

function onTimeoutFieldDescription(deadlines: EvalDeadlineSeconds): string {
	return `'detach' (interactive default): the call returns after ${deadlines.detachAfterSeconds}s of the cell's own work (a host tool call in flight can hold it up to the ${deadlines.foregroundWindowSeconds}s foreground window) while the cell keeps running; completion arrives as a notification. 'error' (print/json default): the call blocks until the cell settles or a deadline kills it.`;
}

export interface EvalToolInput {
	readonly language: EvalLanguage;
	readonly code: string;
	readonly action?: "run";
	readonly summary: string;
	readonly timeout?: number;
	readonly on_timeout?: "detach" | "error";
	readonly reset?: boolean;
}

export interface EvalControlInput {
	readonly action: "peek" | "stop";
	readonly cell_id: string;
}

export type EvalToolRequest = EvalToolInput | EvalControlInput;

function evalInputProperties<Language extends TSchema>(languageSchema: Language, deadlines: EvalDeadlineSeconds) {
	return {
		action: Type.Optional(
			Type.Union([Type.Literal("run"), Type.Literal("peek"), Type.Literal("stop")], {
				description: "Defaults to run. peek and stop require cell_id.",
			}),
		),
		language: Type.Optional(languageSchema),
		code: Type.Optional(Type.String({ description: "Cell body, verbatim." })),
		summary: Type.Optional(
			Type.String({
				maxLength: EVAL_SUMMARY_MAX_LENGTH,
				description:
					"REQUIRED for run. ONE line in the USER'S conversational language (Korean conversation -> Korean summary) stating WHAT this cell does and FOR WHAT PURPOSE; shown in the TUI while the cell runs. Longer values are force-truncated to 80 chars.",
			}),
		),
		timeout: Type.Optional(Type.Number({ minimum: 1, description: timeoutFieldDescription(deadlines) })),
		on_timeout: Type.Optional(
			Type.Union([Type.Literal("detach"), Type.Literal("error")], {
				description: onTimeoutFieldDescription(deadlines),
			}),
		),
		reset: Type.Optional(Type.Boolean({ description: "Reset this language kernel before running." })),
		cell_id: Type.Optional(Type.String({ description: "Detached eval cell id for peek or stop." })),
	};
}

const fullEvalInputSchema = Type.Object(
	evalInputProperties(
		Type.Union([Type.Literal("js"), Type.Literal("py"), Type.Literal("rb"), Type.Literal("jl")], {
			description: LANGUAGE_FIELD_DESCRIPTION,
		}),
		defaultEvalDeadlineSeconds,
	),
);

/** Runtime accepts a discriminated run/control union. */
export type EvalInputSchema = TUnsafe<EvalToolRequest> & Pick<typeof fullEvalInputSchema, "properties">;

export function createEvalInputSchema(
	enabled: EnabledEvalLanguages,
	deadlines: EvalDeadlineSeconds = defaultEvalDeadlineSeconds,
): EvalInputSchema {
	const languages = enabledLanguageList(enabled);
	if (languages.length === 0) throw new Error("eval requires at least one enabled language");
	const languageSchema =
		languages.length === 1
			? Type.Union([Type.Literal(languages[0])], { description: LANGUAGE_FIELD_DESCRIPTION })
			: Type.Union(
					languages.map((item) => Type.Literal(item)),
					{ description: LANGUAGE_FIELD_DESCRIPTION },
				);
	return Type.Unsafe<EvalToolRequest>(Type.Object(evalInputProperties(languageSchema, deadlines))) as EvalInputSchema;
}
export type EvalKernelResult = Extract<KernelToHostMessage, { type: "result" }>;
export type EvalToolCallMessage = Extract<KernelToHostMessage, { type: "tool-call" }>;

export interface EvalKernelRunInput {
	readonly cellId: string;
	readonly code: string;
	readonly timeoutMs?: number;
}

export interface KernelInterruptHandle {
	/** Resolves once the kernel knows whether user state survived the interrupt. */
	readonly stateRetained: Promise<boolean>;
	/** Extra outcome detail worth showing the model, e.g. that a blocked worker was abandoned. */
	readonly note?: string;
}

export interface EvalKernel {
	run(input: EvalKernelRunInput): Promise<EvalKernelResult>;
	interrupt(reason?: string): Promise<KernelInterruptHandle>;
	deliverToolReply(message: Extract<HostToKernelMessage, { type: "tool-reply" }>): void;
	reset(): Promise<void>;
	close(): Promise<void>;
}

export interface EvalKernelManager {
	getKernel(language: EvalLanguage, onMessage: (message: KernelToHostMessage) => void): Promise<EvalKernel>;
}

export type ExecuteTool = (
	toolName: string,
	params: unknown,
	options?: { signal?: AbortSignal; onUpdate?: AgentToolUpdateCallback<unknown>; activateInactiveTool?: boolean },
) => Promise<AgentToolResult<unknown>>;

export interface EvalToolCallSummary {
	readonly name: string;
	readonly ok: boolean;
	readonly error?: string;
	readonly callId?: string;
	readonly args?: unknown;
	readonly argsTruncated?: boolean;
	readonly durationMs?: number;
	readonly resultPreview?: string;
}

export type EvalStatusEvent = { readonly op: string } & Readonly<Record<string, unknown>>;

/** Identity of the runtime executing a kernel: interpreter or JS host. */
export interface EvalRuntimeInfo {
	readonly name: string;
	readonly version: string;
	readonly path?: string;
}

export type EvalRuntimes = Readonly<Partial<Record<EvalLanguage, EvalRuntimeInfo>>>;

export type EvalDisplayOutput =
	| { readonly type: "json"; readonly data: unknown }
	| { readonly type: "image"; readonly data: string; readonly mimeType: string }
	| { readonly type: "markdown"; readonly text: string }
	| { readonly type: "status"; readonly event: EvalStatusEvent };

export type EvalCellResult = {
	readonly index: number;
	readonly summary?: string;
	readonly code: string;
	readonly language: EvalLanguage;
	readonly output: string;
	readonly runtime?: EvalRuntimeInfo;
	readonly status: "pending" | "running" | "detached" | "complete" | "error" | "cancelled";
	readonly exitCode?: number;
	readonly durationMs?: number;
	/** Epoch ms when the cell started; lets renderers tick elapsed time between update events. */
	readonly startedAt?: number;
	readonly statusEvents?: readonly EvalStatusEvent[];
	readonly hasMarkdown?: boolean;
};

export interface EvalToolDetails {
	readonly language: EvalLanguage;
	readonly languages?: readonly EvalLanguage[];
	readonly runtime?: EvalRuntimeInfo;
	readonly summary?: string;
	readonly durationMs: number;
	/** True wall-clock elapsed time since the cell started; `durationMs` stays kernel-reported. */
	readonly wallDurationMs?: number;
	/** Exact count of initiated nested tool calls, including calls still pending at settlement. */
	readonly toolCallCount?: number;
	readonly toolCalls: readonly EvalToolCallSummary[];
	readonly truncated: boolean;
	readonly isError?: boolean;
	readonly phase?: string;
	readonly cells?: readonly EvalCellResult[];
	readonly statusEvents?: readonly EvalStatusEvent[];
	readonly jsonOutputs?: readonly unknown[];
	readonly notice?: string;
	readonly meta?: TruncationMeta;
}
