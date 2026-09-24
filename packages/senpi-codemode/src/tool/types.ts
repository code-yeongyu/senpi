import type { AgentToolResult, AgentToolUpdateCallback, KernelPreludeContribution } from "@code-yeongyu/senpi";
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

export interface EvalListInput {
	readonly action: "list";
}

export type EvalControlInput =
	| EvalListInput
	| {
			readonly action: "peek" | "stop";
			readonly cell_id: string;
	  };

export type EvalToolRequest = EvalToolInput | EvalControlInput;

// Like `summary`, `language` and `code` stay optional in the wire schema because control
// actions share it; the description teaches the requirement and parseEvalRequest enforces it.
const LANGUAGE_FIELD_DESCRIPTION =
	"REQUIRED for run. Kernel that runs the cell; each language keeps its own persistent state across eval calls.";
const CODE_FIELD_DESCRIPTION = "REQUIRED for run. Cell body, verbatim.";

function evalInputProperties<Language extends TSchema>(languageSchema: Language, deadlines: EvalDeadlineSeconds) {
	return {
		action: Type.Optional(
			Type.Union([Type.Literal("run"), Type.Literal("peek"), Type.Literal("stop"), Type.Literal("list")], {
				description:
					"Defaults to run. peek and stop require cell_id. list: live and recently settled cells across languages.",
			}),
		),
		language: Type.Optional(languageSchema),
		code: Type.Optional(Type.String({ description: CODE_FIELD_DESCRIPTION })),
		summary: Type.Optional(
			Type.String({
				description:
					"REQUIRED for run. One line in the language the user writes in: a progress update saying what you are doing and why, not a label for the code; shown in the TUI while the cell runs.",
			}),
		),
		timeout: Type.Optional(Type.Number({ minimum: 1, description: timeoutFieldDescription(deadlines) })),
		on_timeout: Type.Optional(
			Type.Union([Type.Literal("detach"), Type.Literal("error")], {
				description: onTimeoutFieldDescription(deadlines),
			}),
		),
		reset: Type.Optional(
			Type.Boolean({
				description: "Reset this language kernel before running; refused while that language has live cells.",
			}),
		),
		cell_id: Type.Optional(Type.String({ minLength: 1, description: "Eval cell id for peek or stop." })),
	};
}

function evalLanguageUnion(languages: readonly EvalLanguage[]) {
	return Type.Union(
		languages.map((item) => Type.Literal(item)),
		{ description: LANGUAGE_FIELD_DESCRIPTION },
	);
}

const fullEvalInputSchema = Type.Object(
	evalInputProperties(evalLanguageUnion(evalLanguageOrder), defaultEvalDeadlineSeconds),
);

/** Runtime accepts a discriminated run/control union. */
export type EvalInputSchema = TUnsafe<EvalToolRequest> & Pick<typeof fullEvalInputSchema, "properties">;

export function createEvalInputSchema(
	enabled: EnabledEvalLanguages,
	deadlines: EvalDeadlineSeconds = defaultEvalDeadlineSeconds,
): EvalInputSchema {
	const languages = enabledLanguageList(enabled);
	if (languages.length === 0) throw new Error("eval requires at least one enabled language");
	const languageSchema = evalLanguageUnion(languages);
	return Type.Unsafe<EvalToolRequest>(
		Type.Object(evalInputProperties(languageSchema, deadlines), {
			anyOf: [
				{ properties: { action: { enum: ["run", "list"] } } },
				{ properties: { action: { enum: ["peek", "stop"] } }, required: ["action", "cell_id"] },
			],
		}),
	) as EvalInputSchema;
}
export type EvalKernelResult = Extract<KernelToHostMessage, { type: "result" }>;
export type EvalToolCallMessage = Extract<KernelToHostMessage, { type: "tool-call" }>;

export interface EvalKernelRunInput {
	readonly cellId: string;
	readonly code: string;
	readonly timeoutMs?: number;
	readonly onStarted?: () => void;
	readonly onMessage?: (message: KernelToHostMessage) => void;
	/** Globals of the tools active when the cell was submitted; kernels without preludes ignore them. */
	readonly kernelPreludes?: readonly KernelPreludeContribution[];
}

export interface KernelInterruptHandle {
	/** Resolves once the kernel knows whether user state survived the interrupt. */
	readonly stateRetained: Promise<boolean>;
	/** Extra outcome detail worth showing the model, e.g. that a blocked worker was abandoned. */
	readonly note?: string;
}

export interface EvalKernel {
	run(input: EvalKernelRunInput): Promise<EvalKernelResult>;
	cancelQueued(cellId: string, reason: string): boolean;
	interrupt(reason?: string, cellId?: string): Promise<KernelInterruptHandle>;
	queueSnapshot(): { activeCellId: string | null; queuedCellIds: readonly string[] };
	deliverToolReply(message: Extract<HostToKernelMessage, { type: "tool-reply" }>): void;
	reset(): Promise<void>;
	close(): Promise<void>;
	/** Names this kernel has registered; JS collides with other languages in the same session. */
	listKernelToolNames?(): readonly string[];
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
	readonly details?: unknown;
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
	readonly status: "pending" | "queued" | "running" | "detached" | "complete" | "error" | "cancelled";
	readonly queuedBehind?: readonly string[];
	readonly exitCode?: number;
	readonly durationMs?: number;
	/** Epoch ms when the cell started; lets renderers tick elapsed time between update events. */
	readonly startedAt?: number;
	readonly statusEvents?: readonly EvalStatusEvent[];
	readonly hasMarkdown?: boolean;
};

export interface EvalListedCell {
	readonly cellId: string;
	readonly language: EvalLanguage;
	readonly state: "queued" | "running" | "detached" | "completed" | "failed" | "cancelled";
	readonly startedAtMs: number;
	readonly queuedBehind?: readonly string[];
	readonly summary?: string;
}

export interface EvalListDetails {
	readonly action: "list";
	readonly cells: readonly EvalListedCell[];
}

export type EvalResultDetails = EvalToolDetails | EvalListDetails;

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
	/** Machine-readable reason for a tool-boundary cancellation. */
	readonly code?: string;
	readonly phase?: string;
	readonly cells?: readonly EvalCellResult[];
	readonly statusEvents?: readonly EvalStatusEvent[];
	readonly jsonOutputs?: readonly unknown[];
	readonly notice?: string;
	readonly meta?: TruncationMeta;
}
