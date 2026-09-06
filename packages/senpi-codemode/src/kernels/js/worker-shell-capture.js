const SHELL_CONFIG_METHODS = ["env", "cwd", "nothrow", "throws"];
const SHELL_READ_METHODS = ["text", "json", "lines", "arrayBuffer", "bytes", "blob"];

export function installShellCapture(options) {
	const bun = globalThis.Bun;
	if (!isBunRuntime(bun)) return () => {};
	const originalShell = bun.$;
	const originalSpawn = bun.spawn;
	bun.$ = capturedShell(originalShell, options);
	bun.spawn = capturedSpawn(originalSpawn, options);
	return () => {
		bun.$ = originalShell;
		bun.spawn = originalSpawn;
	};
}

function isBunRuntime(bun) {
	return bun !== null && typeof bun === "object" && typeof bun.$ === "function" && typeof bun.spawn === "function";
}

function capturedShell(originalShell, options) {
	const shell = (strings, ...expressions) => {
		const promise = originalShell(strings, ...expressions);
		return options.isActive() ? captureShellPromise(promise, options.emitText) : promise;
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

function capturedSpawn(originalSpawn, options) {
	return (...args) => {
		if (!options.isActive()) return originalSpawn(...args);
		const [first, second] = args;
		if (Array.isArray(first)) {
			const spawnOptions = second === undefined ? {} : second;
			if (!needsStderrCapture(spawnOptions)) return originalSpawn(...args);
			return drainStderr(originalSpawn(first, { ...spawnOptions, stderr: "pipe" }), options.emitText);
		}
		if (!needsStderrCapture(first)) return originalSpawn(...args);
		return drainStderr(originalSpawn({ ...first, stderr: "pipe" }), options.emitText);
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
