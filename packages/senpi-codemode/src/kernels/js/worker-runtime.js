import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { inspect } from "node:util";
import { awaitMaybePromise, indirectEval, wrapUserCode } from "./worker-indirect-eval.js";

export class JsWorkerRuntime {
	#cwd;
	#parallelPoolWidth;
	#env = new Map();
	#hooks = null;

	constructor(options) {
		this.#cwd = options.cwd;
		this.#parallelPoolWidth = options.parallelPoolWidth;
		this.#installGlobals();
	}

	async run(code, cellId, hooks) {
		this.#hooks = hooks;
		try {
			return await awaitMaybePromise(indirectEval(wrapUserCode(code), cellId));
		} finally {
			this.#hooks = null;
		}
	}

	#installGlobals() {
		globalThis.print = (...values) => this.#emitText("stdout", `${values.map(formatValue).join(" ")}\n`);
		globalThis.display = value => this.#display(value);
		globalThis.log = message => this.#hooks?.emit({ type: "log", message: String(message) });
		globalThis.phase = title => this.#hooks?.emit({ type: "phase", title: String(title) });
		globalThis.env = (key, value) => this.#envHelper(key, value);
		globalThis.read = async (path, offset = 1, limit) => await this.#read(path, offset, limit);
		globalThis.write = async (path, content) => await this.#write(path, content);
		globalThis.parallel = async thunks => await this.#parallel(thunks);
		globalThis.pipeline = async (items, ...stages) => await this.#pipeline(items, stages);
		globalThis.completion = async (prompt, opts) => await this.#callTool("completion", { prompt, opts });
		globalThis.tool = new Proxy(
			{},
			{
				get: (_target, prop) => {
					if (typeof prop !== "string") return undefined;
					return async args => await this.#callTool(prop, args);
				},
			},
		);
		const originalLog = console.log.bind(console);
		const originalError = console.error.bind(console);
		console.log = (...values) => {
			this.#emitText("stdout", `${values.map(formatValue).join(" ")}\n`);
		};
		console.error = (...values) => {
			this.#emitText("stderr", `${values.map(formatValue).join(" ")}\n`);
		};
		globalThis.__senpi_restore_console__ = () => {
			console.log = originalLog;
			console.error = originalError;
		};
	}

	#emitText(stream, data) {
		this.#hooks?.emit({ type: "text", stream, data });
	}

	#display(value) {
		if (value && typeof value === "object" && typeof value.mimeType === "string" && typeof value.dataBase64 === "string") {
			this.#hooks?.emit({ type: "display", mimeType: value.mimeType, dataBase64: value.dataBase64 });
			return;
		}
		this.#hooks?.emit({
			type: "display",
			mimeType: "application/json",
			dataBase64: Buffer.from(JSON.stringify(value), "utf8").toString("base64"),
		});
	}

	#envHelper(key, value) {
		if (key === undefined) return { ...process.env, ...Object.fromEntries(this.#env) };
		if (value !== undefined) {
			const stringValue = String(value);
			this.#env.set(String(key), stringValue);
			return stringValue;
		}
		return this.#env.get(String(key)) ?? process.env[String(key)];
	}

	async #read(rawPath, offset, limit) {
		const text = await readFile(this.#resolvePath(String(rawPath)), "utf8");
		if (offset <= 1 && limit === undefined) return text;
		const lines = text.split(/\r?\n/u);
		return lines.slice(Math.max(0, offset - 1), limit === undefined ? undefined : offset - 1 + limit).join("\n");
	}

	async #write(rawPath, content) {
		const path = this.#resolvePath(String(rawPath));
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, String(content));
		return path;
	}

	#resolvePath(path) {
		return isAbsolute(path) ? path : resolve(this.#cwd, path);
	}

	async #callTool(toolName, args) {
		if (!this.#hooks) throw new Error("tool call outside active JS cell");
		return await this.#hooks.callTool(toolName, args);
	}

	async #parallel(thunks) {
		const results = new Array(thunks.length);
		let next = 0;
		const workers = Array.from({ length: Math.min(this.#parallelPoolWidth, thunks.length) }, async () => {
			while (next < thunks.length) {
				const index = next;
				next += 1;
				results[index] = await thunks[index]();
			}
		});
		await Promise.all(workers);
		return results;
	}

	async #pipeline(items, stages) {
		let current = items;
		for (const stage of stages) current = await this.#parallel(current.map(item => async () => await stage(item)));
		return current;
	}
}

function formatValue(value) {
	if (typeof value === "string") return value;
	return inspect(value, { colors: false, depth: 5 });
}
