// An independent model of how procps-ng 4.0.4 `/usr/bin/kill` turns its argv into kill(2) calls, kept apart from the
// guard so the guard can be checked against it. It follows the source line by line:
// - signals.c `skill_sig_option`: the first word `-X` anywhere whose X names a signal is the signal; it is removed.
// - signals.c `signal_name_to_number`: a number is a signal when 0 <= n and n + SIGRTMIN (34) <= 127.
// - kill.c `getopt_long("l::Ls:hVq:")` with GNU permutation: an option character that is a digit is `case '?'`, which
//   signals `'0' - digit` and exits; the remaining operands are signalled in order.
// The model was compared with the real binary under an LD_PRELOAD interposer that records kill(2) and delivers nothing.

const SIGRTMIN = 34;
const NAMES = new Map<string, number>([
	..."HUP INT QUIT ILL TRAP ABRT BUS FPE KILL USR1 SEGV USR2 PIPE ALRM TERM STKFLT CHLD CONT STOP TSTP TTIN TTOU URG XCPU XFSZ VTALRM PROF WINCH POLL PWR SYS"
		.split(" ")
		.map((name, index): [string, number] => [name, index + 1]),
	["CLD", 17],
	["IO", 29],
	["IOT", 6],
	["RTMIN", SIGRTMIN],
]);

/** signals.c `signal_name_to_number`; `undefined` when the text names no signal. */
function signalNumber(text: string): number | undefined {
	let name = text.toUpperCase();
	if (name.startsWith("SIG")) name = name.slice(3);
	const named = NAMES.get(name);
	if (named !== undefined) return named;
	if (name === "EXIT" || name === "NULL") return 0;
	let offset = 0;
	if (name.startsWith("RTMIN+")) {
		name = name.slice(6);
		offset = SIGRTMIN;
	}
	if (!/^\d+$/.test(name)) return undefined;
	const value = Number(name);
	return value + SIGRTMIN > 127 ? undefined : value + offset;
}

export interface ProcpsKill {
	/** The signal procps sends; `undefined` when it prints usage or a listing and signals nothing. */
	readonly signal: number | undefined;
	/** Every pid argument procps passes to kill(2), in order. */
	readonly pids: readonly number[];
}

const NOTHING: ProcpsKill = { signal: undefined, pids: [] };

export function procpsKill(args: readonly string[]): ProcpsKill {
	const argv = [...args];
	const at = argv.findIndex((word) => word.startsWith("-") && signalNumber(word.slice(1)) !== undefined);
	let signal = 15;
	if (at >= 0) {
		signal = signalNumber(argv[at].slice(1)) ?? 15;
		argv.splice(at, 1);
	}
	const operands: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const word = argv[index];
		if (word === "--") {
			operands.push(...argv.slice(index + 1));
			break;
		}
		if (word.startsWith("--")) {
			const [name, value] = word.slice(2).split("=", 2);
			if (name !== "signal" && name !== "queue") return NOTHING;
			const argument = value ?? argv[++index];
			if (name === "signal") signal = argument === undefined ? -1 : (signalNumber(argument) ?? -1);
			continue;
		}
		if (word.length < 2 || !word.startsWith("-")) {
			operands.push(word);
			continue;
		}
		const option = word.charAt(1);
		if (/\d/.test(option)) return { signal, pids: [0 - Number(option)] };
		if (option !== "s" && option !== "q") return NOTHING;
		const argument = word.length > 2 ? word.slice(2) : argv[++index];
		if (option === "s") signal = argument === undefined ? -1 : (signalNumber(argument) ?? -1);
	}
	if (operands.length === 0) return NOTHING;
	const pids: number[] = [];
	for (const operand of operands) {
		if (!/^-?\d+$/.test(operand)) break;
		pids.push(Number(operand));
	}
	return { signal, pids };
}

const SHAPES: readonly (readonly string[])[] = [
	[],
	["-9"],
	["-KILL"],
	["-SIGTERM"],
	["-s", "9"],
	["-s", "KILL"],
	["--signal", "9"],
	["--signal=KILL"],
	["-9", "--"],
	["--"],
	["-s", "9", "--"],
	["-9", "4242"],
	["4242"],
	["-1"],
	["-15"],
	["-0"],
];

const TARGETS = [
	"-1",
	"-1429035",
	"-142903",
	"-1429035a",
	"-1abc",
	"-12",
	"-15",
	"-19",
	"-2429035",
	"-4000",
	"-9429035",
	"-0429035",
	"-2",
	"-9",
	"-0",
	"-93",
	"-94",
	"4242",
	"1429035",
];

/** Every `kill` argv the guard is checked on: each signal shape before each target word. */
export const PROCPS_MATRIX: readonly (readonly string[])[] = SHAPES.flatMap((shape) =>
	TARGETS.map((target) => [...shape, target]),
);
