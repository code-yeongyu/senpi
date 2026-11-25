import type { Readable } from "node:stream";
import { type Static, Type } from "typebox";

const closed = { additionalProperties: false } as const;
const Strings = Type.Array(Type.String());
const Paths = Type.Object({ paths: Type.Optional(Strings), none: Type.Optional(Type.Literal(true)) }, closed);
const ThinkingLevel = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);

/** Which session a launch runs: `--continue`, `--session`, `--session-id`, `--fork`, `--rebind`, `--no-session`, and their companions. */
export const LaunchSessionSchema = Type.Object(
	{
		continue: Type.Optional(Type.Literal(true)),
		path: Type.Optional(Type.String()),
		id: Type.Optional(Type.String()),
		fork: Type.Optional(Type.String()),
		rebind: Type.Optional(Type.String()),
		ephemeral: Type.Optional(Type.Literal(true)),
		dir: Type.Optional(Type.String()),
		spawned_by: Type.Optional(
			Type.Object({ parentSessionId: Type.String(), rootSessionId: Type.String(), taskId: Type.String() }, closed),
		),
		name: Type.Optional(Type.String()),
	},
	closed,
);

/** How the launched engine is set up; the same object `models.list` and `promptSizes` take. */
export const LaunchSetupSchema = Type.Object(
	{
		model: Type.Optional(Type.String()),
		provider: Type.Optional(Type.String()),
		model_patterns: Type.Optional(Strings),
		reasoning: Type.Optional(ThinkingLevel),
		system_prompt: Type.Optional(Type.String()),
		append_system_prompt: Type.Optional(Strings),
		tools: Type.Optional(
			Type.Object(
				{
					allow: Type.Optional(Strings),
					deny: Type.Optional(Strings),
					none: Type.Optional(Type.Literal(true)),
					no_builtin: Type.Optional(Type.Literal(true)),
				},
				closed,
			),
		),
		extensions: Type.Optional(Paths),
		skills: Type.Optional(
			Type.Object({ names: Type.Optional(Strings), none: Type.Optional(Type.Literal(true)) }, closed),
		),
		prompt_templates: Type.Optional(Paths),
		themes: Type.Optional(
			Type.Object(
				{
					paths: Type.Optional(Strings),
					none: Type.Optional(Type.Literal(true)),
					use: Type.Optional(Type.String()),
				},
				closed,
			),
		),
		context_files: Type.Optional(Type.Boolean()),
		project_trust: Type.Optional(Type.Boolean()),
		offline: Type.Optional(Type.Literal(true)),
		session_runtime: Type.Optional(Type.Union([Type.Literal("in-process"), Type.Literal("worker")])),
		tool_runtime: Type.Optional(Type.Union([Type.Literal("in-process"), Type.Literal("child")])),
		auto_title: Type.Optional(Type.Literal(true)),
		extension_flags: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Literal(true)]))),
	},
	closed,
);

/** What the launched engine is asked: messages in order, `@` files, and whether it reads stdin to its end. */
export const LaunchInputSchema = Type.Object(
	{
		messages: Type.Optional(Strings),
		files: Type.Optional(Strings),
		stdin: Type.Optional(Type.Literal(true)),
	},
	closed,
);

export const LaunchPresenterSchema = Type.Object(
	{ bootstrap_fd: Type.Literal(4), enforcement: Type.Optional(Type.Literal(true)) },
	closed,
);

/**
 * A provider key for the launched process, read once from a handle the caller holds and delivered to that
 * process on a private descriptor. It is never an argument, an environment variable or a field of any answer.
 */
export type LaunchKeyHandle = Readable | ReadableStream<Uint8Array>;

/** Every part of a launch (design 6.9). Each launch operation admits the parts of its mode. */
export const LaunchOptionsSchema = Type.Object(
	{
		session: Type.Optional(LaunchSessionSchema),
		setup: Type.Optional(LaunchSetupSchema),
		input: Type.Optional(LaunchInputSchema),
		gated: Type.Optional(Type.Object({ grok_neo: Type.Optional(Type.Literal(true)) }, closed)),
		presenter: Type.Optional(LaunchPresenterSchema),
		api_key: Type.Optional(Type.Unsafe<LaunchKeyHandle>({ description: "a readable handle" })),
		tui_mode: Type.Optional(Type.Union([Type.Literal("regular"), Type.Literal("fullscreen")])),
		verbose: Type.Optional(Type.Literal(true)),
		attach: Type.Optional(Type.Object({ socket: Type.String(), session: Type.String() }, closed)),
		mode: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")])),
		listen: Type.Optional(Type.String()),
		multi_session: Type.Optional(Type.Literal(true)),
	},
	closed,
);

export type LaunchOptions = Static<typeof LaunchOptionsSchema>;
export type LaunchSetup = Static<typeof LaunchSetupSchema>;
export type LaunchSession = Static<typeof LaunchSessionSchema>;
export type LaunchInput = Static<typeof LaunchInputSchema>;

type Common = Pick<LaunchOptions, "session" | "setup" | "api_key">;
export type LaunchInteractiveOptions = Common &
	Pick<LaunchOptions, "input" | "gated" | "tui_mode" | "verbose" | "attach">;
export type LaunchPrintOptions = Common &
	Pick<LaunchOptions, "gated"> & {
		readonly input: LaunchInput;
		readonly mode: "text" | "json";
	};
export type LaunchRpcOptions = Common & Pick<LaunchOptions, "gated" | "listen" | "multi_session" | "presenter">;
export type LaunchHandOptions = Common;
export type LaunchHeadlessOptions = Common & Pick<LaunchOptions, "listen">;

export type LaunchMode = "interactive" | "print" | "rpc" | "hand" | "headless";
