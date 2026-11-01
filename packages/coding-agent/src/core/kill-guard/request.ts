import { spawnSync } from "node:child_process";
import { judgeArgv, judgeCommand, judgeSignal } from "./command.ts";
import { createProcessView, spawnSyncFromNode } from "./process-view.ts";
import type { KillGuardContext, KillGuardShell, KillGuardVantage, KillGuardVerdict, ProcessView } from "./types.ts";
import { refuse } from "./verdict.ts";

/** A check a kernel sends over the codemode bridge: a shell string, a spawn argv, or a signal call. */
export type KillGuardRequest =
	| { readonly kind: "command"; readonly command: string; readonly vantagePid?: number }
	| { readonly kind: "argv"; readonly argv: readonly string[]; readonly vantagePid?: number }
	| {
			readonly kind: "signal";
			readonly target: number;
			readonly group: boolean;
			readonly signal: number | string | null;
			readonly vantagePid?: number;
	  };

export interface KillGuardRequestOptions {
	readonly agentPid: number;
	readonly agentPpid?: number;
	readonly platform?: string;
	/** Defaults to the production view (`/proc` or `ps`, and `pgrep` for dry runs). */
	readonly view?: () => ProcessView | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Parses a bridge request; `undefined` when it is not one of the three shapes. */
export function parseKillGuardRequest(value: unknown): KillGuardRequest | undefined {
	if (!isRecord(value)) return undefined;
	const vantagePid =
		typeof value.vantagePid === "number" && Number.isInteger(value.vantagePid) ? value.vantagePid : undefined;
	const extra = vantagePid === undefined ? {} : { vantagePid };
	if (value.kind === "command" && typeof value.command === "string")
		return { kind: "command", command: value.command, ...extra };
	if (value.kind === "argv" && Array.isArray(value.argv) && value.argv.every((word) => typeof word === "string")) {
		return { kind: "argv", argv: value.argv, ...extra };
	}
	const signal = value.signal;
	if (
		value.kind === "signal" &&
		typeof value.target === "number" &&
		typeof value.group === "boolean" &&
		(typeof signal === "number" || typeof signal === "string" || signal === null)
	) {
		return { kind: "signal", target: value.target, group: value.group, signal, ...extra };
	}
	return undefined;
}

function vantageOf(request: KillGuardRequest, agentPid: number): KillGuardVantage {
	if (request.vantagePid === undefined) return { kind: "fresh-session" };
	return request.vantagePid === agentPid ? { kind: "agent" } : { kind: "process", pid: request.vantagePid };
}

/** The host side of the kernel bridge's kill-guard check (E7, E8): decides one request from its kernel's vantage. */
export function decideKillGuardRequest(value: unknown, options: KillGuardRequestOptions): KillGuardVerdict {
	const request = parseKillGuardRequest(value);
	if (request === undefined) return refuse("R5", "the kill-guard check was malformed");
	const platform = options.platform ?? process.platform;
	let read = false;
	let view: ProcessView | undefined;
	const readView =
		options.view ??
		(() => {
			if (!read) {
				read = true;
				view = createProcessView(platform, spawnSyncFromNode(spawnSync));
			}
			return view;
		});
	const shell: KillGuardShell = request.kind === "command" ? "sh" : "argv";
	const context: KillGuardContext = {
		platform,
		agentPid: options.agentPid,
		...(options.agentPpid === undefined ? {} : { agentPpid: options.agentPpid }),
		vantage: vantageOf(request, options.agentPid),
		shell,
		view: readView,
	};
	switch (request.kind) {
		case "command":
			return judgeCommand(request.command, context);
		case "argv":
			return judgeArgv(request.argv, context);
		case "signal":
			return judgeSignal(
				{ target: request.target, group: request.group, signal: request.signal ?? undefined },
				context,
			);
	}
}
