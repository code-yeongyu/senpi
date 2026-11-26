/**
 * The launch options as the parser's own argv, produced by running the exported command metadata backwards
 * (`ENGINE_COMMANDS`), so the flag-to-field table exists once. The parser then applies its own refusals.
 */
import { type Args, parseArgs } from "../cli/args.ts";
import type { LaunchMode, LaunchOptions, LaunchSetup } from "./launch-options.ts";
import type { EngineCommandFlag, EngineCommandMetadata } from "./metadata-flags.ts";
import { LAUNCH_COMMANDS } from "./metadata-launch.ts";

export function commandOf(mode: LaunchMode): EngineCommandMetadata {
	const command = LAUNCH_COMMANDS.find((entry) => entry.call === `launch.${mode}`);
	if (command === undefined) throw new Error(`no launch metadata for ${mode}`);
	return command;
}

/** Every input flag of every launch mode, once: a field a mode does not admit still reaches the parser's refusal. */
const INPUT_FLAGS: readonly EngineCommandFlag[] = LAUNCH_COMMANDS.flatMap((command) => command.flags).filter(
	(entry, index, all) =>
		entry.mapping.kind === "input" &&
		all.findIndex((other) => other.names[0] === entry.names[0] && sameField(other, entry)) === index,
);

function sameField(a: EngineCommandFlag, b: EngineCommandFlag): boolean {
	return a.mapping.kind === "input" && b.mapping.kind === "input" && a.mapping.field === b.mapping.field;
}

function valueAt(source: unknown, path: string): unknown {
	let value = source;
	for (const key of path.split(".")) {
		if (typeof value !== "object" || value === null) return undefined;
		value = Reflect.get(value, key);
	}
	return value;
}

function flagArgv(entry: EngineCommandFlag, source: unknown): string[] {
	if (entry.mapping.kind !== "input") return [];
	const { field, format } = entry.mapping;
	const name = entry.names[0] ?? "";
	const value = valueAt(source, field);
	if (value === undefined) return [];
	if (!entry.takesValue) return value === (entry.mapping.value ?? true) ? [name] : [];
	const items = Array.isArray(value) ? value.map(String) : [];
	switch (format) {
		case "list":
			return items.flatMap((item) => [name, item]);
		case "comma_list":
			return [name, items.join(",")];
		case "json":
			return [name, JSON.stringify(value)];
		case "duration":
			return [name, `${String(value)}ms`];
		case undefined:
			return [name, String(value)];
		default: {
			const exhaustive: never = format;
			return exhaustive;
		}
	}
}

/** One command's argv from its input: its words, the selectors its form requires, then its input flags. */
export function commandArgv(command: EngineCommandMetadata, source: unknown): string[] {
	return [...command.argv, ...selectorArgv(command), ...command.flags.flatMap((entry) => flagArgv(entry, source))];
}

function selectorArgv(command: EngineCommandMetadata): string[] {
	return command.flags.flatMap((entry) => {
		if (entry.required !== true || entry.mapping.kind !== "selector") return [];
		const name = entry.names[0] ?? "";
		return entry.mapping.value === undefined ? [name] : [name, entry.mapping.value];
	});
}

function extensionFlagArgv(setup: LaunchSetup | undefined): string[] {
	return Object.entries(setup?.extension_flags ?? {}).map(([name, value]) =>
		value === true ? `--${name}` : `--${name}=${value}`,
	);
}

function setupFlags(): readonly EngineCommandFlag[] {
	return INPUT_FLAGS.filter((entry) => entry.mapping.kind === "input" && entry.mapping.field.startsWith("setup."));
}

export function setupArgv(setup: LaunchSetup | undefined): string[] {
	const source = { setup };
	return [...setupFlags().flatMap((entry) => flagArgv(entry, source)), ...extensionFlagArgv(setup)];
}

/** The argv of one launch: the mode's selector first (so `--listen` is read), flags, files, then messages after `--`. */
export function launchArgv(mode: LaunchMode, options: LaunchOptions): string[] {
	const withAttach =
		options.attach === undefined
			? options
			: { ...options, session: { ...options.session, path: options.attach.session } };
	const flags = INPUT_FLAGS.flatMap((entry) => flagArgv(entry, withAttach));
	const files = (options.input?.files ?? []).map((file) => `@${file}`);
	const messages = options.input?.messages ?? [];
	return [
		...selectorArgv(commandOf(mode)),
		...flags,
		...extensionFlagArgv(options.setup),
		...files,
		...(messages.length > 0 ? ["--", ...messages] : []),
	];
}

export function parseLaunchArgv(argv: readonly string[]): { readonly args: Args } | { readonly refusal: string } {
	try {
		const args = parseArgs([...argv]);
		const errors = args.diagnostics.filter((diagnostic) => diagnostic.type === "error");
		return errors.length > 0 ? { refusal: errors.map((diagnostic) => diagnostic.message).join("\n") } : { args };
	} catch (error: unknown) {
		return { refusal: error instanceof Error ? error.message : String(error) };
	}
}
