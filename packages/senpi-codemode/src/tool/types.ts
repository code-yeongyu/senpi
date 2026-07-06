import type { AgentToolResult, AgentToolUpdateCallback } from "@code-yeongyu/senpi";
import { Type } from "typebox";
import type { HostToKernelMessage, KernelToHostMessage } from "../bridge/protocol.ts";

export const evalLanguageOrder = ["py", "js", "rb", "jl"] as const;
export type EvalLanguage = (typeof evalLanguageOrder)[number];
export type EnabledEvalLanguages = Readonly<Record<EvalLanguage, boolean>>;

export function enabledLanguageList(enabled: EnabledEvalLanguages): EvalLanguage[] {
	return evalLanguageOrder.filter((language) => enabled[language]);
}

const fullEvalInputSchema = Type.Object({
	language: Type.Union([Type.Literal("py"), Type.Literal("js"), Type.Literal("rb"), Type.Literal("jl")]),
	code: Type.String({ description: "Cell body, verbatim." }),
	title: Type.Optional(Type.String({ description: "Short transcript label." })),
	timeout: Type.Optional(Type.Number({ minimum: 1, description: "Timeout in seconds." })),
	reset: Type.Optional(Type.Boolean({ description: "Reset this language kernel before running." })),
});

export function createEvalInputSchema(enabled: EnabledEvalLanguages): typeof fullEvalInputSchema {
	const languages = enabledLanguageList(enabled);
	if (languages.length === 0) throw new Error("eval requires at least one enabled language");
	const languageSchema =
		languages.length === 1
			? Type.Union([Type.Literal(languages[0])])
			: Type.Union(languages.map((item) => Type.Literal(item)));
	return Type.Object({
		language: languageSchema,
		code: Type.String({ description: "Cell body, verbatim." }),
		title: Type.Optional(Type.String({ description: "Short transcript label." })),
		timeout: Type.Optional(Type.Number({ minimum: 1, description: "Timeout in seconds." })),
		reset: Type.Optional(Type.Boolean({ description: "Reset this language kernel before running." })),
	}) as typeof fullEvalInputSchema;
}

export type EvalInputSchema = ReturnType<typeof createEvalInputSchema>;
export interface EvalToolInput {
	readonly language: EvalLanguage;
	readonly code: string;
	readonly title?: string;
	readonly timeout?: number;
	readonly reset?: boolean;
}
export type EvalKernelResult = Extract<KernelToHostMessage, { type: "result" }>;
export type EvalToolCallMessage = Extract<KernelToHostMessage, { type: "tool-call" }>;

export interface EvalKernelRunInput {
	readonly cellId: string;
	readonly code: string;
	readonly timeoutMs?: number;
}

export interface EvalKernel {
	run(input: EvalKernelRunInput): Promise<EvalKernelResult>;
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

export interface EvalToolDetails {
	readonly language: EvalLanguage;
	readonly title?: string;
	readonly durationMs: number;
	readonly toolCalls: readonly EvalToolCallSummary[];
	readonly truncated: boolean;
	readonly isError?: boolean;
	readonly phase?: string;
}
