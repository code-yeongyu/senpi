// Signal numbers by machine OS, for the 128 + n exit code of a signal-killed shell on a machine this process cannot
// ask `os.constants.signals` about (test/tools-core/posix-signals.test.ts checks the host's table against Node's).

// The table every OS got before the tables were split by OS; no OS may number fewer of these.
const COMMON: Readonly<Record<string, number>> = {
	SIGHUP: 1,
	SIGINT: 2,
	SIGQUIT: 3,
	SIGILL: 4,
	SIGTRAP: 5,
	SIGABRT: 6,
	SIGFPE: 8,
	SIGKILL: 9,
	SIGSEGV: 11,
	SIGPIPE: 13,
	SIGALRM: 14,
	SIGTERM: 15,
};

const LINUX: Readonly<Record<string, number>> = {
	SIGHUP: 1,
	SIGINT: 2,
	SIGQUIT: 3,
	SIGILL: 4,
	SIGTRAP: 5,
	SIGABRT: 6,
	SIGIOT: 6,
	SIGBUS: 7,
	SIGFPE: 8,
	SIGKILL: 9,
	SIGUSR1: 10,
	SIGSEGV: 11,
	SIGUSR2: 12,
	SIGPIPE: 13,
	SIGALRM: 14,
	SIGTERM: 15,
	SIGSTKFLT: 16,
	SIGCHLD: 17,
	SIGCONT: 18,
	SIGSTOP: 19,
	SIGTSTP: 20,
	SIGTTIN: 21,
	SIGTTOU: 22,
	SIGURG: 23,
	SIGXCPU: 24,
	SIGXFSZ: 25,
	SIGVTALRM: 26,
	SIGPROF: 27,
	SIGWINCH: 28,
	SIGIO: 29,
	SIGPOLL: 29,
	SIGPWR: 30,
	SIGSYS: 31,
};

// Darwin and the BSDs share this numbering.
const BSD: Readonly<Record<string, number>> = {
	SIGHUP: 1,
	SIGINT: 2,
	SIGQUIT: 3,
	SIGILL: 4,
	SIGTRAP: 5,
	SIGABRT: 6,
	SIGIOT: 6,
	SIGEMT: 7,
	SIGFPE: 8,
	SIGKILL: 9,
	SIGBUS: 10,
	SIGSEGV: 11,
	SIGSYS: 12,
	SIGPIPE: 13,
	SIGALRM: 14,
	SIGTERM: 15,
	SIGURG: 16,
	SIGSTOP: 17,
	SIGTSTP: 18,
	SIGCONT: 19,
	SIGCHLD: 20,
	SIGTTIN: 21,
	SIGTTOU: 22,
	SIGIO: 23,
	SIGXCPU: 24,
	SIGXFSZ: 25,
	SIGVTALRM: 26,
	SIGPROF: 27,
	SIGWINCH: 28,
	SIGINFO: 29,
	SIGUSR1: 30,
	SIGUSR2: 31,
};

// Node's win32 numbers (libuv), over COMMON for the names Node does not define there.
const WIN32: Readonly<Record<string, number>> = {
	...COMMON,
	SIGHUP: 1,
	SIGINT: 2,
	SIGILL: 4,
	SIGABRT: 22,
	SIGFPE: 8,
	SIGKILL: 9,
	SIGSEGV: 11,
	SIGTERM: 15,
	SIGBREAK: 21,
	SIGWINCH: 28,
};

const BSD_FAMILY = new Set(["darwin", "freebsd", "openbsd", "netbsd", "dragonfly"]);

/** The signal table of a machine's OS; an OS without its own table gets the common POSIX numbers. */
export function posixSignalTable(os: string): Readonly<Record<string, number>> {
	if (os === "linux" || os === "android") return LINUX;
	if (BSD_FAMILY.has(os)) return BSD;
	if (os === "win32") return WIN32;
	return COMMON;
}
