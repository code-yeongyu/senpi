/**
 * `ctx.offload` (senpi#3566 todo 8): a registered child module, resolved to the `module` job shape todo 4 ships
 * (`{ modulePath, export, args }`), runs through the session's runtime-selected dispatcher. Under `in-process` the
 * server imports the same module and runs its export (`in-process-module.ts`); under `child` the dispatcher hands the job to the session's
 * tool child. Both report a module that cannot be loaded as `offload_module_unavailable`.
 */
import { dirname, isAbsolute, resolve } from "node:path";
import type { OffloadOptions, RegisteredChildModule } from "../extensions/types.ts";
import type { ToolChildModuleJob, ToolDispatcher } from "./tool-dispatcher.ts";

export type OffloadErrorCode =
	| "offload_module_unavailable"
	| "offload_unknown_module"
	| "offload_bad_registration"
	| "offload_bad_options"
	| "offload_session_closed"
	| "tool_child_deadline"
	| "tool_runtime_unavailable";

export class OffloadError extends Error {
	readonly code: OffloadErrorCode;
	constructor(code: OffloadErrorCode, message: string) {
		super(`${code}: ${message}`);
		this.name = "OffloadError";
		this.code = code;
	}
}

/** A registration as it is stored: a file-backed module only (an inline function is refused at registration). */
export function validateChildModuleRegistration(registration: unknown): void {
	const field = (name: string): unknown =>
		typeof registration === "object" && registration !== null ? Reflect.get(registration, name) : undefined;
	for (const name of ["id", "module", "export"])
		if (typeof field(name) !== "string" || field(name) === "")
			throw new OffloadError(
				"offload_bad_registration",
				`registerChildModule needs a non-empty string ${name}${name === "module" ? " (a file path; inline functions are not accepted)" : ""}`,
			);
	const idempotent = field("idempotent");
	if (idempotent !== undefined && typeof idempotent !== "boolean")
		throw new OffloadError("offload_bad_registration", "registerChildModule idempotent must be a boolean");
}

/** The absolute module path a registration names: relative paths resolve against the registering extension's file. */
export function childModulePath(entry: RegisteredChildModule): string {
	const module = entry.registration.module;
	if (isAbsolute(module)) return module;
	return resolve(dirname(entry.sourceInfo.path), module);
}

export function offloadJob(
	entry: RegisteredChildModule,
	args: unknown,
	deadlineMs: number | undefined,
): ToolChildModuleJob {
	return {
		modulePath: childModulePath(entry),
		export: entry.registration.export,
		args,
		...(entry.registration.idempotent === true ? { idempotent: true } : {}),
		...(deadlineMs === undefined ? {} : { deadlineMs }),
	};
}
/** The module files registered child modules name: granted to the session's child alongside its tools' modules. */
export function childModuleRoots(modules: ReadonlyMap<string, RegisteredChildModule>): string[] {
	return [...modules.values()]
		.filter((entry) => isAbsolute(entry.registration.module) || !entry.sourceInfo.path.startsWith("<"))
		.map(childModulePath);
}

/** `ctx.offload(id, args, options)`: the registered module, run where the session's dispatcher places it. */
export async function offload(
	dispatcher: Pick<ToolDispatcher, "offload">,
	modules: ReadonlyMap<string, RegisteredChildModule>,
	id: string,
	args: unknown,
	options: OffloadOptions | undefined,
): Promise<unknown> {
	const deadlineMs = options?.deadlineMs;
	if (deadlineMs !== undefined && !(Number.isFinite(deadlineMs) && deadlineMs > 0))
		throw new OffloadError(
			"offload_bad_options",
			`deadlineMs must be a finite number of ms above 0, not ${deadlineMs}`,
		);
	const entry = modules.get(id);
	if (entry === undefined)
		throw new OffloadError("offload_unknown_module", `no child module is registered as "${id}"`);
	const outcome = await dispatcher.offload(offloadJob(entry, args, options?.deadlineMs), options?.signal);
	return outcome.value;
}
