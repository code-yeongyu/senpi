import type { JsEnvironments } from "../environments/js-environments.ts";
import type { PythonEnvironments } from "../environments/python-environments.ts";
import { TIMEOUT_PAUSE_OP, TIMEOUT_RESUME_OP } from "../timeouts/bridge-timeout.ts";
import { MagicCellError, parseMagicCell } from "./magic-cells.ts";
import type { EvalLanguage, HostCellExecutor } from "./types.ts";

export type MagicCellPlan =
	| { readonly kind: "ordinary" }
	| { readonly kind: "host"; readonly executor: HostCellExecutor }
	| { readonly kind: "refused"; readonly message: string }
	| { readonly kind: "load"; readonly target: string };

export function planMagicCell(
	language: EvalLanguage,
	code: string,
	environments: PythonEnvironments | undefined,
	jsEnvironments?: JsEnvironments,
): MagicCellPlan {
	let magic: ReturnType<typeof parseMagicCell>;
	try {
		magic = parseMagicCell(language, code);
	} catch (error) {
		if (error instanceof MagicCellError) return { kind: "refused", message: error.message };
		throw error;
	}
	if (magic === undefined) return { kind: "ordinary" };
	if (magic.kind === "load") return { kind: "load", target: magic.target };
	if (language === "js") return planJsMagic(magic, jsEnvironments);
	if (environments === undefined) {
		return {
			kind: "refused",
			message: "environment_installer_unavailable: this session has no Python interpreter to install packages for",
		};
	}
	if (magic.kind === "environment") {
		const mode = magic.mode;
		return {
			kind: "host",
			executor: async () => {
				const root = await environments.setMode(mode);
				return { ok: true, valueRepr: `environment: ${mode} (${root})` };
			},
		};
	}
	const requirements = magic.args;
	return {
		kind: "host",
		// Install time is parked time for the run budget, the same accounting as a bridge call.
		executor: async ({ signal, emit }) => {
			emit({ type: "status", event: { op: TIMEOUT_PAUSE_OP } });
			try {
				const receipt = await environments.install(requirements, signal, (stream, data) =>
					emit({ type: "text", stream, data }),
				);
				const packages = receipt.resolved.length > 0 ? receipt.resolved.join(", ") : "nothing new";
				return {
					ok: true,
					valueRepr: `installed ${packages} into ${receipt.mode} (revision ${receipt.revision}); already-imported modules stay cached until reset`,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, error: { message } };
			} finally {
				emit({ type: "status", event: { op: TIMEOUT_RESUME_OP } });
			}
		},
	};
}

function planJsMagic(
	magic: Exclude<NonNullable<ReturnType<typeof parseMagicCell>>, { kind: "load" }>,
	environments: JsEnvironments | undefined,
): MagicCellPlan {
	if (environments === undefined) {
		return {
			kind: "refused",
			message: "environment_installer_unavailable: this session has no JavaScript package environment",
		};
	}
	if (magic.kind === "environment") {
		const mode = magic.mode;
		return {
			kind: "host",
			executor: async () => {
				const root = await environments.setMode(mode);
				return { ok: true, valueRepr: `environment: ${mode} (${root})` };
			},
		};
	}
	if (magic.kind !== "js-add") return { kind: "refused", message: "this magic is not available in JavaScript" };
	const requested = magic.args;
	return {
		kind: "host",
		executor: async ({ signal, emit }) => {
			emit({ type: "status", event: { op: TIMEOUT_PAUSE_OP } });
			try {
				const receipt = await environments.install(requested, signal, (stream, data) =>
					emit({ type: "text", stream, data }),
				);
				const added = receipt.added.length > 0 ? receipt.added.join(", ") : "nothing new";
				const where =
					receipt.revision === undefined ? receipt.mode : `${receipt.mode} (revision ${receipt.revision})`;
				const shadow =
					receipt.shadowed.length > 0
						? `; environment_resolution_conflict: ${receipt.shadowed.join(", ")} still resolve from the project's node_modules first`
						: "";
				return {
					ok: true,
					valueRepr: `added ${added} with ${receipt.installer} into ${where}${shadow}; already-imported modules stay cached until reset`,
				};
			} catch (error) {
				return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } };
			} finally {
				emit({ type: "status", event: { op: TIMEOUT_RESUME_OP } });
			}
		},
	};
}
