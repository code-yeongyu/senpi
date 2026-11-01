// senpi#5349 / code-yeongyu/oh-my-openagent#12096: every signal a JS cell can send goes through the kill guard's judge
// first, whether or not a cell is active (a timer from an earlier cell signals too). The judge is the coding agent's
// own module, imported by URL at worker init; its process-table reads and dry runs use a spawnSync captured before any
// judging wrapper exists, so judging never re-enters a judging wrapper (amendment A8).

const { promisify } = process.getBuiltinModule("node:util");
const childProcess = process.getBuiltinModule("node:child_process");

// The permission runtime hands over the engine's own spawnSync (never a cell-facing wrapper) before any cell runs.
let engineSpawnSync;

export function initializeKillGuardSpawn(spawnSync) {
	engineSpawnSync ??= spawnSync;
}

function capturedSpawnSync(judge) {
	if (typeof engineSpawnSync === "function") return judge.spawnSyncFromNode(engineSpawnSync);
	const bun = globalThis.Bun;
	if (bun !== null && typeof bun === "object" && typeof bun.spawnSync === "function") {
		const original = bun.spawnSync;
		return judge.spawnSyncFromBun((argv, options) => original(argv, options));
	}
	const original = childProcess.spawnSync;
	return judge.spawnSyncFromNode((file, args, options) => original(file, args, options));
}

function refusal(message) {
	const error = new Error(message);
	error.name = "KillGuardError";
	error.code = "kill_guard_refused";
	return error;
}

/** The checks a worker runs before a shell string, an argv or a signal leaves the cell. */
export function createKillGuard({ judge, agentPid }) {
	const spawnSync = capturedSpawnSync(judge);
	// The in-thread worker signals as the agent itself; a process-isolation kernel signals as its own process.
	const vantage = process.pid === agentPid ? { kind: "agent" } : { kind: "process", pid: process.pid };
	const context = (shell) =>
		judge.killGuardContext({
			platform: process.platform,
			agentPid,
			...(vantage.kind === "agent" ? { agentPpid: process.ppid } : {}),
			vantage,
			shell,
			spawnSync,
		});
	const enforce = (verdict) => {
		if (verdict.action === "refuse") throw refusal(verdict.message);
	};
	return {
		command: (text, shell) => enforce(judge.judgeCommand(String(text), context(shell))),
		argv: (argv) => enforce(judge.judgeArgv(argv.map(String), context("argv"))),
		signal: (target, signal) =>
			enforce(judge.judgeSignal({ target: Number(target), group: false, signal: signal ?? "SIGTERM" }, context("argv"))),
	};
}

function childProcessCheck(guard, name, args) {
	const [file, second, third] = args;
	if (name === "exec" || name === "execSync") return guard.command(file, "sh");
	const argv = Array.isArray(second) ? second : [];
	const options = Array.isArray(second) || second == null ? third : second;
	if (options?.shell) return guard.command([file, ...argv].join(" "), "sh");
	return guard.argv([file, ...argv]);
}

const SPAWNERS = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"];

/** Wraps node:child_process and process.kill; returns the restore. */
export function installKillGuardWrappers(guard) {
	const originals = new Map();
	for (const name of SPAWNERS) {
		const original = childProcess[name];
		if (typeof original !== "function") continue;
		originals.set(name, original);
		const guarded = function killGuarded(...args) {
			childProcessCheck(guard, name, args);
			return original.apply(this, args);
		};
		// Every own property, symbols included: `util.promisify.custom` is what makes promisify(exec) resolve to
		// { stdout, stderr }, and that custom function calls the original directly, so it is checked too.
		for (const key of Reflect.ownKeys(original)) {
			if (key === "length" || key === "name" || key === "prototype" || key === promisify.custom) continue;
			const descriptor = Object.getOwnPropertyDescriptor(original, key);
			if (descriptor) Object.defineProperty(guarded, key, descriptor);
		}
		const custom = original[promisify.custom];
		if (typeof custom === "function") {
			Object.defineProperty(guarded, promisify.custom, {
				configurable: true,
				value: function killGuardedPromisified(...args) {
					childProcessCheck(guard, name, args);
					return custom.apply(this, args);
				},
			});
		}
		childProcess[name] = guarded;
	}
	const originalKill = process.kill;
	process.kill = function killGuardedSignal(pid, signal) {
		guard.signal(pid, signal);
		return originalKill.call(process, pid, signal);
	};
	return () => {
		process.kill = originalKill;
		for (const [name, original] of originals) childProcess[name] = original;
	};
}

/** The text Bun.$ runs: each interpolated value is one escaped word, as Bun passes it (`{ raw }` stays raw). */
export function renderShellTemplate(strings, expressions, escape) {
	if (!Array.isArray(strings)) return String(strings ?? "");
	const quote = typeof escape === "function" ? (value) => escape(String(value)) : (value) => String(value);
	const render = (value) => {
		if (Array.isArray(value)) return value.map(render).join(" ");
		if (value !== null && typeof value === "object" && typeof value.raw === "string") return value.raw;
		return quote(value);
	};
	return strings.reduce((text, part, index) => text + part + (index < expressions.length ? render(expressions[index]) : ""), "");
}
