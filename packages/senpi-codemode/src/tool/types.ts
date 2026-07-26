import type { AgentToolResult, AgentToolUpdateCallback } from "@code-yeongyu/senpi";
import { type TUnsafe, Type } from "typebox";
import type { HostToKernelMessage, KernelToHostMessage } from "../bridge/protocol.ts";
import type { TruncationMeta } from "../output/output-meta.ts";

export const evalLanguageOrder = ["py", "js", "rb", "jl"] as const;
export type EvalLanguage = (typeof evalLanguageOrder)[number];
export type EnabledEvalLanguages = Readonly<Record<EvalLanguage, boolean>>;

export function enabledLanguageList(enabled: EnabledEvalLanguages): EvalLanguage[] {
	return evalLanguageOrder.filter((language) => enabled[language]);
}

export interface EvalToolInput {
	readonly language: EvalLanguage;
	readonly code: string;
	readonly action?: "run";
	readonly title?: string;
	readonly timeout?: number;
	readonly on_timeout?: "detach" | "error";
	readonly reset?: boolean;
}

export interface EvalControlInput {
	readonly action: "peek" | "stop";
	readonly cell_id: string;
}

export type EvalToolRequest = EvalToolInput | EvalControlInput;

const fullEvalInputSchema = Type.Object({
	action: Type.Optional(
		Type.Union([Type.Literal("run"), Type.Literal("peek"), Type.Literal("stop")], {
			description: "Defaults to run. peek and stop require cell_id.",
		}),
	),
	language: Type.Optional(
		Type.Union([Type.Literal("py"), Type.Literal("js"), Type.Literal("rb"), Type.Literal("jl")]),
	),
	code: Type.Optional(Type.String({ description: "Cell body, verbatim." })),
	title: Type.Optional(Type.String({ description: "Short transcript label." })),
	timeout: Type.Optional(Type.Number({ minimum: 1, description: "Timeout in seconds." })),
	on_timeout: Type.Optional(
		Type.Union([Type.Literal("detach"), Type.Literal("error")], {
			description: "Timeout behavior. Interactive sessions detach by default; print/json sessions error by default.",
		}),
	),
	reset: Type.Optional(Type.Boolean({ description: "Reset this language kernel before running." })),
	cell_id: Type.Optional(Type.String({ description: "Detached eval cell id for peek or stop." })),
});

/** Runtime accepts a discriminated run/control union. */
export type EvalInputSchema = TUnsafe<EvalToolRequest> & Pick<typeof fullEvalInputSchema, "properties">;

export function createEvalInputSchema(enabled: EnabledEvalLanguages): EvalInputSchema {
	const languages = enabledLanguageList(enabled);
	if (languages.length === 0) throw new Error("eval requires at least one enabled language");
	const languageSchema =
		languages.length === 1
			? Type.Union([Type.Literal(languages[0])])
			: Type.Union(languages.map((item) => Type.Literal(item)));
	return Type.Unsafe<EvalToolRequest>(
		Type.Object({
			action: Type.Optional(
				Type.Union([Type.Literal("run"), Type.Literal("peek"), Type.Literal("stop")], {
					description: "Defaults to run. peek and stop require cell_id.",
				}),
			),
			language: Type.Optional(languageSchema),
			code: Type.Optional(Type.String({ description: "Cell body, verbatim." })),
			title: Type.Optional(Type.String({ description: "Short transcript label." })),
			timeout: Type.Optional(Type.Number({ minimum: 1, description: "Timeout in seconds." })),
			on_timeout: Type.Optional(
				Type.Union([Type.Literal("detach"), Type.Literal("error")], {
					description:
						"Timeout behavior. Interactive sessions detach by default; print/json sessions error by default.",
				}),
			),
			reset: Type.Optional(Type.Boolean({ description: "Reset this language kernel before running." })),
			cell_id: Type.Optional(Type.String({ description: "Detached eval cell id for peek or stop." })),
		}),
	) as EvalInputSchema;
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
	options?: { signal?: AbortSignal; onUpdate?: AgentToolUpdateCallback<unknown> },
) => Promise<AgentToolResult<unknown>>;

export interface EvalToolCallSummary {
	readonly name: string;
	readonly ok: boolean;
	readonly error?: string;
}

export type EvalStatusEvent = { readonly op: string } & Readonly<Record<string, unknown>>;

export type EvalDisplayOutput =
	| { readonly type: "json"; readonly data: unknown }
	| { readonly type: "image"; readonly data: string; readonly mimeType: string }
	| { readonly type: "markdown"; readonly text: string }
	| { readonly type: "status"; readonly event: EvalStatusEvent };

export type EvalCellResult = {
	readonly index: number;
	readonly title?: string;
	readonly code: string;
	readonly language: EvalLanguage;
	readonly output: string;
	readonly status: "pending" | "running" | "detached" | "complete" | "error" | "cancelled";
	readonly exitCode?: number;
	readonly durationMs?: number;
	readonly statusEvents?: readonly EvalStatusEvent[];
	readonly hasMarkdown?: boolean;
};

export interface EvalToolDetails {
	readonly language: EvalLanguage;
	readonly languages?: readonly EvalLanguage[];
	readonly title?: string;
	readonly durationMs: number;
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
