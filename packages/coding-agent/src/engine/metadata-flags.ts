/** The flag vocabulary of the engine command metadata, and the flag sets several commands share. */
/** The launch slice that adds the inputs this slice does not export (endpoint, key root, presenter, setup). */
export const GATED_SLICE = "E1a-s";

export type EngineFlagMapping =
	/** Fills `field` of the call's input; `value` is what a flag that takes no value sets. */
	| { readonly kind: "input"; readonly field: string; readonly value?: boolean | string }
	/** Selects this command among the forms of the same argv; fills nothing. */
	| { readonly kind: "selector" }
	/** Changes only how the answer is printed. */
	| { readonly kind: "render" }
	/** Accepted by the parser for every form of the command, with no effect on this one. */
	| { readonly kind: "ignored" }
	/** An input the exported function gains in E1a-s; recorded as a gap, never as unmapped. */
	| { readonly kind: "gated"; readonly slice: typeof GATED_SLICE; readonly field: string };

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
}

export interface EngineCommandMetadata {
	/** The exported function: `engine.<call>`. */
	readonly call: string;
	/** The leading argv words; empty for a root flag such as `--list-tips`. */
	readonly argv: readonly string[];
	readonly aliases?: readonly (readonly string[])[];
	readonly positionals: readonly EngineCommandPositional[];
	readonly flags: readonly EngineCommandFlag[];
}

export const input = (field: string, value?: boolean | string): EngineFlagMapping =>
	value === undefined ? { kind: "input", field } : { kind: "input", field, value };
export const gated = (field: string): EngineFlagMapping => ({ kind: "gated", slice: GATED_SLICE, field });
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
export const positional = (name: string, field: string, optional = false): EngineCommandPositional => ({
	name,
	field,
	optional,
});

export const TRUST_FLAGS = [
	flag(["--approve", "-a"], false, input("trust", true)),
	flag(["--no-approve", "-na"], false, input("trust", false)),
];
export const LOCAL_FLAG = flag(["--local", "-l"], false, input("local", true));

/** The launch setup flags (design 6.9, `setup`); `--list-models` and `--print-prompt-sizes` read them today. */
export const SETUP_FLAGS: readonly EngineCommandFlag[] = [
	["--model", true, "setup.model"],
	["--provider", true, "setup.provider"],
	["--models", true, "setup.model_patterns"],
	["--thinking", true, "setup.reasoning"],
	["--system-prompt", true, "setup.system_prompt"],
	["--append-system-prompt", true, "setup.append_system_prompt"],
	["--tools", true, "setup.tools.allow"],
	["--exclude-tools", true, "setup.tools.deny"],
	["--no-tools", false, "setup.tools.none"],
	["--no-builtin-tools", false, "setup.tools.no_builtin"],
	["--extension", true, "setup.extensions.paths"],
	["--no-extensions", false, "setup.extensions.none"],
	["--skill", true, "setup.skills.names"],
	["--no-skills", false, "setup.skills.none"],
	["--prompt-template", true, "setup.prompt_templates.paths"],
	["--no-prompt-templates", false, "setup.prompt_templates.none"],
	["--theme", true, "setup.themes.paths"],
	["--no-themes", false, "setup.themes.none"],
	["--use-theme", true, "setup.themes.use"],
	["--no-context-files", false, "setup.context_files"],
	["--approve", false, "setup.project_trust"],
	["--no-approve", false, "setup.project_trust"],
	["--offline", false, "setup.offline"],
	["--session-runtime", true, "setup.session_runtime"],
	["--tool-runtime", true, "setup.tool_runtime"],
	["--auto-title-sessions", false, "setup.auto_title"],
].map(([name, takesValue, field]) => flag([String(name)], takesValue === true, gated(String(field))));

const ENDPOINT_FLAGS = [
	flag(["--socket"], true, gated("endpoint.socket")),
	flag(["--rpc-key-root"], true, gated("endpoint.key_root")),
];
export const PRESENTER_FLAGS = [
	flag(["--mcp-presenter-fd"], true, gated("presenter.bootstrap_fd")),
	flag(["--mcp-presenter-enforcement"], false, gated("presenter.enforcement")),
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
