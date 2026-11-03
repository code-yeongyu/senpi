import { assertCellLive } from "./cell-run-context.js";
import { groupSignalNotice, noticeChildProcessGroupSignals, shellCommandText, signalsProcessGroup } from "./group-signal-notice.js";
import { createKillGuard, installKillGuardWrappers, renderShellTemplate } from "./worker-kill-guard.js";

const SHELL_CONFIG_METHODS = ["env", "cwd", "nothrow", "throws"];
const SHELL_READ_METHODS = ["text", "json", "lines", "arrayBuffer", "bytes", "blob"];
// `true | ( … )` hands every command in the template an empty pipe as stdin. The worker thread shares
// the host process's fd 0 (the TUI's terminal), which Bun.$ would otherwise inherit, so a stdin
// reader would wait on the user's keyboard forever. The newline before `)` keeps a trailing comment
// from swallowing the closing paren; the Bun shell has no other stdin control (no `$.stdin`, no
// redirect on a subshell).
const STDIN_ISOLATION_HEAD = "true | (\n";
const STDIN_ISOLATION_TAIL = "\n)";

export function installShellCapture(options) {
	// Created before any wrapper below, so the judge's own reads use the originals (A8).
	const guard = options.killGuard === undefined ? undefined : createKillGuard(options.killGuard);
	const bun = globalThis.Bun;
	if (!isBunRuntime(bun)) return guard === undefined ? () => {} : installKillGuardWrappers(guard);
	const originalShell = bun.$;
	const originalSpawn = bun.spawn;
	const originalSpawnSync = typeof bun.spawnSync === "function" ? bun.spawnSync : null;
	const deletedKeys = globalThis.__senpi_session_env_deletions__;
	const pinEnv =
		globalThis.__senpi_session_env_applied__ === true || (Array.isArray(deletedKeys) && deletedKeys.length > 0);
	if (pinEnv && typeof originalShell.env === "function") {
		// Bun.spawn without an explicit env inherits the OS environ, not the worker's process.env,
		// and deleting from process.env does not unsetenv under Bun. Pinning the worker's
		// environment view mirrors the bash tool, which always spawns with an explicit env.
		originalShell.env({ ...process.env });
	}
	bun.$ = capturedShell(originalShell, options, guard);
	bun.spawn = capturedSpawn(originalSpawn, options, pinEnv, guard);
	if (originalSpawnSync !== null) bun.spawnSync = capturedSpawnSync(originalSpawnSync, pinEnv, guard);
	const restoreChildProcessNotice = noticeChildProcessGroupSignals(options.emitText, options.isActive);
	// Outermost, so a refused command never reaches the group-signal notice.
	const restoreKillGuard = guard === undefined ? () => {} : installKillGuardWrappers(guard);
	return () => {
		restoreKillGuard();
		restoreChildProcessNotice();
		bun.$ = originalShell;
		bun.spawn = originalSpawn;
		if (originalSpawnSync !== null) bun.spawnSync = originalSpawnSync;
	};
}

function isBunRuntime(bun) {
	return bun !== null && typeof bun === "object" && typeof bun.$ === "function" && typeof bun.spawn === "function";
}

function capturedShell(originalShell, options, guard, escape = originalShell.escape) {
	const shell = (strings, ...expressions) => {
		assertCellLive();
		guard?.command(renderShellTemplate(strings, expressions, escape), "bun");
		if (!options.isActive()) return originalShell(strings, ...expressions);
		if (signalsProcessGroup(shellCommandText(strings, expressions))) options.emitText("stderr", groupSignalNotice("Bun.$"));
		const promise = originalShell(isolateStdin(strings), ...expressions);
		return captureShellPromise(promise, options);
	};
	copyShellKeys(shell, originalShell);
	if (typeof originalShell.Shell === "function") shell.Shell = capturedShellClass(originalShell.Shell, options, guard, escape);
	for (const method of SHELL_CONFIG_METHODS) {
		shell[method] = (...args) => {
			originalShell[method](...args);
			return shell;
		};
	}
	return shell;
}

// Copies the shell's enumerable own keys the wrapper does not already own, as ordinary writable properties. A
// function's own `name` and `length` are read-only, so assigning them throws in a module: on Bun 1.4.4 the only own
// enumerable key of a `new Bun.$.Shell()` instance is `name`. The source's flags are not copied either, because
// `Bun.$.Shell` itself is non-writable there and the wrapper replaces it right after.
function copyShellKeys(target, source) {
	for (const key of Object.keys(source)) {
		if (Object.hasOwn(target, key)) continue;
		Object.defineProperty(target, key, { value: source[key], writable: true, enumerable: true, configurable: true });
	}
}

// `new Bun.$.Shell()` builds an independent `$` with its own env and cwd; each instance is judged and captured
// exactly like `Bun.$` itself, so it is no way around the kill guard.
function capturedShellClass(OriginalShell, options, guard, escape) {
	return function Shell(...args) {
		return capturedShell(new OriginalShell(...args), options, guard, escape);
	};
}

function isolateStdin(strings) {
	if (!Array.isArray(strings) || !Array.isArray(strings.raw)) return strings;
	const cooked = [...strings];
	const raw = [...strings.raw];
	const last = cooked.length - 1;
	cooked[0] = `${STDIN_ISOLATION_HEAD}${cooked[0]}`;
	raw[0] = `${STDIN_ISOLATION_HEAD}${raw[0]}`;
	cooked[last] = `${cooked[last]}${STDIN_ISOLATION_TAIL}`;
	raw[last] = `${raw[last]}${STDIN_ISOLATION_TAIL}`;
	return Object.freeze(Object.assign(cooked, { raw: Object.freeze(raw) }));
}

function captureShellPromise(promise, options) {
	const prototype = Object.getPrototypeOf(promise);
	let waiting = false;
	let settled = false;
	const finish = () => {
		settled = true;
		if (waiting) options.onShellWait?.(promise, false);
		waiting = false;
	};
	let echo = true;
	const echoOnce = (output) => {
		if (!echo) return;
		echo = false;
		emitShellOutput(output, options.emitText);
	};
	prototype.quiet.call(promise);
	promise.quiet = function quiet() {
		echo = false;
		return prototype.quiet.call(this);
	};
	for (const method of SHELL_READ_METHODS) {
		if (typeof prototype[method] !== "function") continue;
		promise[method] = function read(...args) {
			echo = false;
			return prototype[method].apply(this, args);
		};
	}
	// oxlint-disable-next-line unicorn/no-thenable -- This wraps an existing shell promise to record when the cell awaits it.
	promise.then = function then(onFulfilled, onRejected) {
		if (!waiting && !settled) {
			waiting = true;
			options.onShellWait?.(promise, true);
		}
		return prototype.then.call(
			this,
			(output) => {
				finish();
				echoOnce(output);
				return onFulfilled ? onFulfilled(output) : output;
			},
			(error) => {
				finish();
				echoOnce(error);
				if (onRejected) return onRejected(error);
				throw error;
			},
		);
	};
	return promise;
}

function emitShellOutput(output, emitText) {
	if (output === null || typeof output !== "object") return;
	const stdout = outputText(output.stdout);
	if (stdout) emitText("stdout", stdout);
	const stderr = outputText(output.stderr);
	if (stderr) emitText("stderr", stderr);
}

function outputText(value) {
	if (value instanceof Uint8Array) return new TextDecoder().decode(value);
	return typeof value === "string" ? value : "";
}

// Bun.spawnSync inherits the OS environ the same way Bun.spawn does, so a cell calling it
// without an explicit env must get the worker's view pinned too (measured on Bun 1.4.0).
function capturedSpawnSync(originalSpawnSync, pinEnv, guard) {
	return (...args) => {
		assertCellLive();
		judgeSpawn(guard, args[0]);
		if (!pinEnv) return originalSpawnSync(...args);
		const [first, second] = args;
		if (Array.isArray(first)) {
			const spawnOptions = second === undefined ? {} : second;
			if (spawnOptions === null || typeof spawnOptions !== "object" || spawnOptions.env !== undefined)
				return originalSpawnSync(...args);
			return originalSpawnSync(first, { ...spawnOptions, env: { ...process.env } });
		}
		if (first !== null && typeof first === "object" && first.env === undefined)
			return originalSpawnSync({ ...first, env: { ...process.env } });
		return originalSpawnSync(...args);
	};
}

function judgeSpawn(guard, first) {
	const argv = Array.isArray(first) ? first : first?.cmd;
	if (guard !== undefined && Array.isArray(argv)) guard.argv(argv);
}

function capturedSpawn(originalSpawn, options, pinEnv, guard) {
	return (...args) => {
		assertCellLive();
		judgeSpawn(guard, args[0]);
		if (!options.isActive()) return originalSpawn(...args);
		const [first, second] = args;
		let child;
		if (Array.isArray(first)) {
			const spawnOptions = second === undefined ? {} : second;
			const effective = pinEnv && spawnOptions.env === undefined ? { ...spawnOptions, env: { ...process.env } } : spawnOptions;
			child = needsStderrCapture(effective)
				? drainStderr(originalSpawn(first, { ...effective, stderr: "pipe" }), options.emitText)
				: effective === spawnOptions
					? originalSpawn(...args)
					: originalSpawn(first, effective);
		} else {
			const effective = pinEnv && first !== null && typeof first === "object" && first.env === undefined ? { ...first, env: { ...process.env } } : first;
			child = needsStderrCapture(effective)
				? drainStderr(originalSpawn({ ...effective, stderr: "pipe" }), options.emitText)
				: effective === first
					? originalSpawn(...args)
					: originalSpawn(effective);
		}
		options.onChild?.(child, Array.isArray(first) ? second : first);
		return child;
	};
}

function needsStderrCapture(spawnOptions) {
	return (
		spawnOptions !== null &&
		typeof spawnOptions === "object" &&
		spawnOptions.stdio === undefined &&
		spawnOptions.stderr === undefined
	);
}

function drainStderr(child, emitText) {
	const stream = child?.stderr;
	if (!(stream instanceof ReadableStream)) return child;
	void readStream(stream, emitText).catch((error) => {
		emitText("stderr", `[spawn stderr capture failed: ${String(error)}]\n`);
	});
	return child;
}

async function readStream(stream, emitText) {
	const decoder = new TextDecoder();
	for await (const chunk of stream) {
		const text = decoder.decode(chunk, { stream: true });
		if (text) emitText("stderr", text);
	}
	const tail = decoder.decode();
	if (tail) emitText("stderr", tail);
}
