/**
 * The ops the engine serves for the relay host (senpi#6752), each with the relay host's own decoder and run step. The
 * relay host keeps policy.get/set, agent.restart, machine.preflight/update/update_status, service.restart and
 * doctor.report; an op not listed here is refused malformed, as the relay host refuses an op it does not offer.
 */
import * as core from "./core-ops.ts";
import * as args from "./op-args.ts";
import * as term from "./terminal-args.ts";
import type { TerminalOps, TerminalRun } from "./terminal-ops.ts";
import type { Args, OpOutcome } from "./wire.ts";

export type OpCall = core.CoreCall &
	TerminalRun &
	Readonly<{ terminal: TerminalOps; pidOf: (handleId: string) => number | undefined }>;

export interface MachineOpEntry {
	readonly decode: (a: Args) => string | undefined;
	readonly run: (a: Args, call: OpCall) => Promise<OpOutcome>;
}

const decoded = <D>(decode: (a: Args) => D, a: Args): { readonly d: D } | { readonly problem: string } => {
	try {
		return { d: decode(a) };
	} catch (error) {
		if (error instanceof args.ArgsError) return { problem: error.message };
		throw error;
	}
};
const entry = <D>(decode: (a: Args) => D, run: (d: D, call: OpCall) => Promise<OpOutcome>): MachineOpEntry => ({
	decode: (a) => {
		const r = decoded(decode, a);
		return "problem" in r ? r.problem : undefined;
	},
	run: (a, call) => {
		const r = decoded(decode, a);
		return "problem" in r
			? Promise.resolve({ state: "refused", error: { code: "malformed", message: r.problem } })
			: run(r.d, call);
	},
});

const SERVED: Readonly<Record<string, MachineOpEntry>> = {
	"fs.read": entry(args.readArgs, core.runRead),
	"fs.read_range": entry(args.readRangeArgs, core.runRead),
	"fs.write": entry(args.writeArgs, core.runWrite),
	"fs.write_range": entry(args.writeRangeArgs, core.runWrite),
	"fs.edit": entry(args.editArgs, core.runEdit),
	"fs.glob": entry(args.globArgs, core.runGlob),
	"fs.grep": entry(args.grepArgs, core.runGrep),
	"fs.stat": entry(args.statArgs, core.runStat),
	"fs.list": entry(args.listArgs, core.runList),
	shell: entry(args.shellArgs, core.runShell),
	"process.info": entry(args.processInfoArgs, (d, call) => core.runProcessInfo(d, call, call.pidOf)),
	"mesh.message": entry(args.meshMessageArgs, core.runMeshMessage),
	exec_command: entry(term.execCommandArgs, (d, call) => call.terminal.execCommand(d, call)),
	write_stdin: entry(term.writeStdinArgs, (d, call) => call.terminal.writeStdin(d, call)),
	wait_for_command: entry(term.waitForCommandArgs, (d, call) => call.terminal.waitForCommand(d, call)),
	kill_terminal: entry(term.killTerminalArgs, (d, call) => call.terminal.killTerminal(d)),
};

/** The served op's entry (own keys only: an op named like an Object prototype key has none). */
export const servedOp = (name: string): MachineOpEntry | undefined =>
	Object.hasOwn(SERVED, name) ? SERVED[name] : undefined;
