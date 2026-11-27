/** The flag vocabulary of the engine command metadata, and the flag sets several commands share. */

/**
 * How one flag's text becomes an input value. `list`: the flag repeats and each occurrence adds one item.
 * `comma_list`: one value holds every item, joined by commas. `json`: the value is a JSON document.
 * `duration`: a number with a unit (`30m`, `1h`), answered as milliseconds.
 */
export type EngineFlagFormat = "list" | "comma_list" | "json" | "duration";

export type EngineFlagMapping =
	/** Fills `field` of the call's input; `value` is what a flag that takes no value sets. */
	| {
			readonly kind: "input";
			readonly field: string;
			readonly value?: boolean | string;
			readonly format?: EngineFlagFormat;
	  }
	/** Selects this command among the forms of the same argv; fills nothing. `value` is the one value it takes. */
	| { readonly kind: "selector"; readonly value?: string }
	/** Changes only how the answer is printed. */
	| { readonly kind: "render" }
	/** Accepted by the parser for every form of the command, with no effect on this one. */
	| { readonly kind: "ignored" }
	/**
	 * A credential input. The exported function reads it from a readable handle and never from argv; the flag is
	 * the command line's own way to give it and is never produced from the function's input.
	 */
	| { readonly kind: "handle"; readonly field: string };

export interface EngineCommandFlag {
	/** The long flag first, then its short aliases. */
	readonly names: readonly string[];
	readonly takesValue: boolean;
	/** The command is this form only with the flag present. */
	readonly required?: boolean;
	readonly mapping: EngineFlagMapping;
}

export interface EngineCommandPositional {
	readonly name: string;
	readonly field: string;
	readonly optional: boolean;
	/** Every remaining positional fills the field, in order. */
	readonly variadic?: boolean;
	/** The text each positional of this field begins with (`@` for a file). */
	readonly prefix?: string;
}

export interface EngineCommandMetadata {
	/** The exported function: `engine.<call>`. */
	readonly call: string;
	/** The leading argv words; empty for a root flag such as `--list-tips`. */
	readonly argv: readonly string[];
	readonly aliases?: readonly (readonly string[])[];
	/** `tui`: not an argv leaf of its own; the command's terminal UI performs it (a space press on a resource). */
	readonly via?: "tui";
	readonly positionals: readonly EngineCommandPositional[];
	readonly flags: readonly EngineCommandFlag[];
}

export const input = (field: string, value?: boolean | string, format?: EngineFlagFormat): EngineFlagMapping => ({
	kind: "input",
	field,
	...(value === undefined ? {} : { value }),
	...(format === undefined ? {} : { format }),
});
export const flag = (names: readonly string[], takesValue: boolean, mapping: EngineFlagMapping): EngineCommandFlag => ({
	names,
	takesValue,
	mapping,
});
export const requiredFlag = (
	names: readonly string[],
	takesValue: boolean,
	mapping: EngineFlagMapping,
): EngineCommandFlag => ({
	...flag(names, takesValue, mapping),
	required: true,
});
export const positional = (
	name: string,
	field: string,
	optional = false,
	shape: { readonly variadic?: boolean; readonly prefix?: string } = {},
): EngineCommandPositional => ({
	name,
	field,
	optional,
	...shape,
});

export const TRUST_FLAGS = [
	flag(["--approve", "-a"], false, input("trust", true)),
	flag(["--no-approve", "-na"], false, input("trust", false)),
];
export const LOCAL_FLAG = flag(["--local", "-l"], false, input("local", true));

/** The launch setup flags (design 6.9, `setup`), with the field and value each fills. */
export const SETUP_FLAGS: readonly EngineCommandFlag[] = [
	flag(["--model"], true, input("setup.model")),
	flag(["--provider"], true, input("setup.provider")),
	flag(["--models"], true, input("setup.model_patterns", undefined, "comma_list")),
	flag(["--thinking"], true, input("setup.reasoning")),
	flag(["--system-prompt"], true, input("setup.system_prompt")),
	flag(["--append-system-prompt"], true, input("setup.append_system_prompt", undefined, "list")),
	flag(["--tools", "-t"], true, input("setup.tools.allow", undefined, "comma_list")),
	flag(["--exclude-tools", "-xt"], true, input("setup.tools.deny", undefined, "comma_list")),
	flag(["--no-tools", "-nt"], false, input("setup.tools.none", true)),
	flag(["--no-builtin-tools", "-nbt"], false, input("setup.tools.no_builtin", true)),
	flag(["--extension", "-e"], true, input("setup.extensions.paths", undefined, "list")),
	flag(["--no-extensions", "-ne"], false, input("setup.extensions.none", true)),
	flag(["--skill"], true, input("setup.skills.names", undefined, "list")),
	flag(["--no-skills", "-ns"], false, input("setup.skills.none", true)),
	flag(["--prompt-template"], true, input("setup.prompt_templates.paths", undefined, "list")),
	flag(["--no-prompt-templates", "-np"], false, input("setup.prompt_templates.none", true)),
	flag(["--theme"], true, input("setup.themes.paths", undefined, "list")),
	flag(["--no-themes"], false, input("setup.themes.none", true)),
	flag(["--use-theme"], true, input("setup.themes.use")),
	flag(["--no-context-files", "-nc"], false, input("setup.context_files", false)),
	flag(["--approve", "-a"], false, input("setup.project_trust", true)),
	flag(["--no-approve", "-na"], false, input("setup.project_trust", false)),
	flag(["--offline"], false, input("setup.offline", true)),
	flag(["--session-runtime"], true, input("setup.session_runtime")),
	flag(["--tool-runtime"], true, input("setup.tool_runtime")),
	flag(["--auto-title-sessions"], false, input("setup.auto_title", true)),
];

/** The endpoint selector of the host commands: paths only, never the credentials under them. */
const ENDPOINT_FLAGS = [
	flag(["--socket"], true, input("endpoint.socket")),
	flag(["--rpc-key-root"], true, input("endpoint.key_root")),
];
export const PRESENTER_FLAGS = [
	flag(["--mcp-presenter-fd"], true, input("presenter.bootstrap_fd")),
	flag(["--mcp-presenter-enforcement"], false, input("presenter.enforcement", true)),
];
const HOST_JSON = flag(["--json"], false, { kind: "render" });
/** `host` accepts these for every subcommand; the ones a subcommand does not read are `ignored` there. */
const HOST_SHARED: Readonly<Record<string, EngineCommandFlag>> = {
	"--launch-spec": flag(["--launch-spec"], true, { kind: "ignored" }),
	"--policy": flag(["--policy"], true, { kind: "ignored" }),
	"--include-workers": flag(["--include-workers"], false, { kind: "ignored" }),
	"--drain": flag(["--drain"], false, { kind: "ignored" }),
	"--force": flag(["--force"], false, { kind: "ignored" }),
};
export function hostFlags(used: readonly EngineCommandFlag[]): EngineCommandFlag[] {
	const usedNames = new Set(used.map((entry) => entry.names[0]));
	const ignored = Object.entries(HOST_SHARED)
		.filter(([name]) => !usedNames.has(name))
		.map(([, entry]) => entry);
	return [...used, ...ignored, ...ENDPOINT_FLAGS, HOST_JSON];
}
