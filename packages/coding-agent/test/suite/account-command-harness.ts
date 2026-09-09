import type { AuthInteraction } from "@earendil-works/pi-ai";
import type { AuthStorage } from "../../src/core/auth-storage.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionMode,
	ExtensionUIDialogOptions,
	RegisteredCommand,
} from "../../src/core/extensions/types.ts";

export type Command = Pick<RegisteredCommand, "handler">;
export type Notice = { message: string; type: "info" | "warning" | "error" | undefined };
export type DialogCall =
	| { kind: "select"; title: string; options: string[]; signal: AbortSignal | undefined }
	| { kind: "input"; title: string; placeholder: string | undefined; signal: AbortSignal | undefined };
export type DialogAnswers = {
	select?: (title: string, options: string[]) => string | undefined;
	input?: (
		title: string,
		placeholder: string | undefined,
		opts: ExtensionUIDialogOptions | undefined,
	) => Promise<string | undefined>;
};
export type ContextOptions = { mode?: ExtensionMode; dialogs?: DialogAnswers };
export type LoginFn = (provider: string, method: string, interaction: AuthInteraction) => Promise<void>;

export type AccountCommandContext = {
	ctx: ExtensionCommandContext;
	notices: Notice[];
	dialogs: DialogCall[];
};

export function registerCommand(name: string, register: (pi: ExtensionAPI) => void): Command {
	const commands = new Map<string, Command>();
	const pi = {
		registerCommand: (commandName: string, command: Command) => commands.set(commandName, command),
	} as unknown as ExtensionAPI;
	register(pi);
	const registered = commands.get(name);
	if (!registered) throw new Error(`/${name} was not registered`);
	return registered;
}

/** Dialog fakes record every call; an unanswered input resolves to "" (Enter on an empty field). */
export function createAccountCommandContext(
	storage: AuthStorage,
	cwd: string,
	options: ContextOptions = {},
): AccountCommandContext {
	const notices: Notice[] = [];
	const dialogs: DialogCall[] = [];
	return {
		ctx: {
			hasUI: true,
			mode: options.mode ?? "tui",
			cwd,
			signal: undefined,
			sessionManager: { getSessionId: () => "session-01" },
			modelRegistry: { authStorage: storage },
			ui: {
				notify: (message: string, type?: Notice["type"]) => notices.push({ message, type }),
				select: async (title: string, choices: string[], opts?: ExtensionUIDialogOptions) => {
					dialogs.push({ kind: "select", title, options: choices, signal: opts?.signal });
					return options.dialogs?.select?.(title, choices);
				},
				input: async (title: string, placeholder?: string, opts?: ExtensionUIDialogOptions) => {
					dialogs.push({ kind: "input", title, placeholder, signal: opts?.signal });
					return options.dialogs?.input ? options.dialogs.input(title, placeholder, opts) : "";
				},
			},
		} as unknown as ExtensionCommandContext,
		notices,
		dialogs,
	};
}

export function createLoginCommandContext(
	storage: AuthStorage,
	cwd: string,
	login: LoginFn,
	options: ContextOptions = {},
): AccountCommandContext & { logins: string[] } {
	const context = createAccountCommandContext(storage, cwd, options);
	const logins: string[] = [];
	const runtime = {
		login: async (provider: string, method: string, interaction: AuthInteraction) => {
			logins.push(`${provider}:${method}`);
			await login(provider, method, interaction);
		},
	};
	Object.assign(context.ctx.modelRegistry, { modelRuntime: runtime });
	return { ...context, logins };
}
