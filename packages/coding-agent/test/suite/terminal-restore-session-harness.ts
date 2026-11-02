import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
import { theme } from "../../src/modes/interactive/theme/theme.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

export interface ToolResultLike {
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
	details?: { bash_id?: string; monitor_id?: string };
}

export interface ToolLike {
	name: string;
	execute: (id: string, input: Record<string, unknown>) => Promise<ToolResultLike>;
}

export interface SentMessage {
	message: { customType: string; content: string; display: boolean; details?: unknown };
	options: { triggerTurn?: boolean; deliverAs?: string };
}

export interface SessionGeneration {
	readonly pi: ExtensionAPI;
	readonly ctx: ExtensionContext;
	readonly tools: Map<string, ToolLike>;
	readonly sent: SentMessage[];
	readonly statuses: Array<[string, string | undefined]>;
	readonly notices: string[];
	emit(eventType: string, payload: Record<string, unknown>): Promise<void>;
	/** Bind or drop the active model, as model_select / an unconfigured start would. */
	setModel(model: { id: string; api: string } | undefined): void;
}

export interface GenerationOptions {
	readonly cwd: string;
	readonly sessionId: string;
	readonly sessionDir: string;
	readonly mode?: string;
	readonly withModel?: boolean;
}

/** One fake extension-runner generation over a real session dir; every UI call is captured. */
export function createSessionGeneration(options: GenerationOptions): SessionGeneration {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, ToolLike>();
	const sent: SentMessage[] = [];
	const statuses: Array<[string, string | undefined]> = [];
	const notices: string[] = [];
	let activeTools: string[] = [];
	const pi = {
		registerTool: (tool: ToolLike) => tools.set(tool.name, tool),
		registerMessageRenderer: () => {},
		on: (eventType: string, handler: Handler) => {
			handlers.set(eventType, [...(handlers.get(eventType) ?? []), handler]);
		},
		sendMessage: (message: SentMessage["message"], sendOptions: SentMessage["options"]) => {
			sent.push({ message, options: sendOptions });
		},
		sendUserMessage: () => {},
		getActiveTools: () => activeTools,
		setActiveTools: (next: string[]) => {
			activeTools = next;
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: options.cwd,
		mode: options.mode ?? "tui",
		model: options.withModel === false ? undefined : { id: "test-model", api: "openai-completions" },
		ui: {
			setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
			notify: (text: string) => notices.push(text),
			theme,
		},
		sessionManager: {
			getSessionId: () => options.sessionId,
			getSessionFile: () => join(options.sessionDir, `${options.sessionId}.jsonl`),
			getSessionDir: () => options.sessionDir,
		},
	} as unknown as ExtensionContext & { model: unknown };
	return {
		pi,
		ctx,
		tools,
		sent,
		statuses,
		notices,
		async emit(eventType, payload) {
			for (const handler of handlers.get(eventType) ?? []) await handler(payload, ctx);
		},
		setModel(model) {
			(ctx as { model: unknown }).model = model;
		},
	};
}

export function firstText(result: ToolResultLike | undefined): string {
	return result?.content.find((block) => block.type === "text")?.text ?? "";
}
