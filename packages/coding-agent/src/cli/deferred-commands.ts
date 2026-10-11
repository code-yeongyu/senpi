/**
 * Route-first dispatch for the one-shot commands whose implementations are heavy module graphs.
 *
 * `main()` calls the package, config and app-server handlers unconditionally, and each of them
 * starts by rejecting argv that does not select it. Statically importing them to ask that question
 * made every launch - interactive, print, RPC - evaluate `package-manager-cli.ts` and the whole
 * `modes/app-server/` tree (70 modules) before argv was even parsed. The rejection is a single
 * argv[0] comparison, so it happens here and the implementation stays behind an `await import(...)`
 * that only the selected command pays for.
 *
 * The argv[0] conditions below mirror the ones inside the implementations: `parsePackageCommand()`
 * and `handleConfigCommand()` in `../package-manager-cli.ts`, `handleAppServerCommand()` in
 * `./app-server-command.ts`. The package verbs are pinned to the `PackageCommand` union at compile
 * time; the two string literals are pinned by `test/suite/regressions/1781-main-lazy-modes.test.ts`.
 */
import type { PackageCommand, PackageCommandRuntimeOptions } from "../package-manager-cli.ts";

/** `satisfies` makes a new `PackageCommand` member a compile error here instead of a dead route. */
const PACKAGE_COMMAND_ARGV = {
	install: true,
	remove: true,
	update: true,
	list: true,
} satisfies Record<PackageCommand, true>;

/** `parsePackageCommand()` maps this alias onto `remove`. */
const PACKAGE_COMMAND_ALIAS = "uninstall";

export const CONFIG_COMMAND_ARGV = "config";
export const APP_SERVER_COMMAND_ARGV = "app-server";
export const HOST_COMMAND_ARGV = "host";
export const SCHEDULE_COMMAND_ARGV = "schedule";

/** True when argv[0] selects a package-manager verb, matching `parsePackageCommand()`. */
export function isPackageCommandArgv(args: readonly string[]): boolean {
	const command = args[0] ?? "";
	return Object.hasOwn(PACKAGE_COMMAND_ARGV, command) || command === PACKAGE_COMMAND_ALIAS;
}

export async function dispatchPackageCommand(
	args: string[],
	runtimeOptions: PackageCommandRuntimeOptions = {},
): Promise<boolean> {
	if (!isPackageCommandArgv(args)) return false;
	const { handlePackageCommand } = await import("../package-manager-cli.ts");
	return await handlePackageCommand(args, runtimeOptions);
}

export async function dispatchConfigCommand(
	args: string[],
	runtimeOptions: PackageCommandRuntimeOptions = {},
): Promise<boolean> {
	if (args[0] !== CONFIG_COMMAND_ARGV) return false;
	const { handleConfigCommand } = await import("../package-manager-cli.ts");
	return await handleConfigCommand(args, runtimeOptions);
}

export async function dispatchAppServerCommand(args: readonly string[]): Promise<boolean> {
	if (args[0] !== APP_SERVER_COMMAND_ARGV) return false;
	const { handleAppServerCommand } = await import("./app-server-command.ts");
	return await handleAppServerCommand(args);
}

/**
 * The daemon command answers with an EXIT CODE rather than a boolean: `senpi host` classifies its
 * outcome (refused, fallback, unusable spec) in that code, and a caller parses it without reading
 * the JSON line. `undefined` means this argv is not a host command at all.
 */
export async function dispatchHostCommand(args: readonly string[]): Promise<number | undefined> {
	if (args[0] !== HOST_COMMAND_ARGV) return undefined;
	if (args[1] === "session") {
		const { runHostSessionCommand } = await import("./host-session-command.ts");
		return await runHostSessionCommand(args.slice(2));
	}
	const { runHostCommand } = await import("./host-command.ts");
	return await runHostCommand(args.slice(1));
}

/**
 * `senpi schedule` fires durable scheduled prompts out of process; like `host` it answers with an
 * exit code, and `undefined` means this argv is not a schedule command.
 */
export async function dispatchScheduleCommand(args: readonly string[]): Promise<number | undefined> {
	if (args[0] !== SCHEDULE_COMMAND_ARGV) return undefined;
	const { runScheduleCommand } = await import("./schedule-command.ts");
	return await runScheduleCommand(args.slice(1));
}
