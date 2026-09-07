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
	const bun = globalThis.Bun;
	if (!isBunRuntime(bun)) return () => {};
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
	bun.$ = capturedShell(originalShell, options);
	bun.spawn = capturedSpawn(originalSpawn, options, pinEnv);
	if (originalSpawnSync !== null) bun.spawnSync = capturedSpawnSync(originalSpawnSync, pinEnv);
	return () => {
		bun.$ = originalShell;
		bun.spawn = originalSpawn;
		if (originalSpawnSync !== null) bun.spawnSync = originalSpawnSync;
	};
}

function isBunRuntime(bun) {
	return bun !== null && typeof bun === "object" && typeof bun.$ === "function" && typeof bun.spawn === "function";
}

function capturedShell(originalShell, options) {
	const shell = (strings, ...expressions) => {
		if (!options.isActive()) return originalShell(strings, ...expressions);
		const promise = originalShell(isolateStdin(strings), ...expressions);
		return captureShellPromise(promise, options.emitText);
	};
	for (const key of Object.keys(originalShell)) shell[key] = originalShell[key];
	for (const method of SHELL_CONFIG_METHODS) {
		shell[method] = (...args) => {
			originalShell[method](...args);
			return shell;
		};
	}
	return shell;
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

function captureShellPromise(promise, emitText) {
	const prototype = Object.getPrototypeOf(promise);
	let echo = true;
	const echoOnce = (output) => {
		if (!echo) return;
		echo = false;
		emitShellOutput(output, emitText);
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
	promise.then = function then(onFulfilled, onRejected) {
		return prototype.then.call(
			this,
			(output) => {
				echoOnce(output);
				return onFulfilled ? onFulfilled(output) : output;
			},
			(error) => {
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
function capturedSpawnSync(originalSpawnSync, pinEnv) {
	return (...args) => {
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

function capturedSpawn(originalSpawn, options, pinEnv) {
	return (...args) => {
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
		options.onChild?.(child);
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
