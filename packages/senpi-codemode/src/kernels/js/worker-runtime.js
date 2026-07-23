// allow: SIZE_OK — private runtime state and installed globals must stay in one worker module.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { inspect } from "node:util";
import { awaitMaybePromise, indirectEval, wrapUserCode } from "./worker-indirect-eval.js";

const PREPARED_CELL_PREFIX = "/*senpi:prepared-cell*/";
const INTERNAL_URL = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/iu;
const BASE64_STRICT_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const DECIMAL_CSV_RE = /^\d{1,3}(?:,\d{1,3})*$/u;

export class JsWorkerRuntime {
	#cwd;
	#parallelPoolWidth;
	#localRoots;
	#env = new Map();
	#hooks = null;

	constructor(options) {
		this.#cwd = options.cwd;
		this.#parallelPoolWidth = options.parallelPoolWidth;
		this.#localRoots = { ...(options.localRoots ?? {}) };
		if (options.artifactsDir && !this.#localRoots.local) this.#localRoots.local = join(options.artifactsDir, "local");
		this.#installGlobals();
	}

	async run(code, cellId, hooks) {
		this.#hooks = hooks;
		try {
			let prelude = "";
			let cellCode = code;
			if (code.startsWith(PREPARED_CELL_PREFIX)) {
				const prepared = JSON.parse(code.slice(PREPARED_CELL_PREFIX.length));
				if (!isPlainObject(prepared) || typeof prepared.prelude !== "string" || typeof prepared.code !== "string") throw new Error("Invalid prepared JavaScript cell payload");
				({ prelude, code: cellCode } = prepared);
			}
			if (prelude) indirectEval(prelude, `${cellId}:prelude`);
			return await awaitMaybePromise(indirectEval(wrapUserCode(cellCode), cellId));
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
		globalThis.read = async (path, options, ...rest) => await this.#read(path, helperOptions("read", options, rest));
		globalThis.write = async (path, content) => await this.#write(path, content);
		globalThis.output = async (...args) => await this.#output(args);
		globalThis.agent = async (prompt, options, ...rest) => await this.#agent(prompt, options, rest);
		globalThis.parallel = async thunks => await this.#parallel(thunks);
		globalThis.pipeline = async (items, ...stages) => await this.#pipeline(items, stages);
		globalThis.completion = async (prompt, opts) => await this.#callTool("completion", { prompt, opts });
		globalThis.tool = new Proxy(
			{},
			{
				get: (_target, prop) => {
					if (typeof prop !== "string") return undefined;
					return async args => await this.#callTool(prop, args ?? {});
				},
			},
		);
		globalThis.tools = globalThis.tool;
		const originalLog = console.log.bind(console);
		const originalError = console.error.bind(console);
		const originalStdoutWrite = process.stdout.write;
		const originalStderrWrite = process.stderr.write;
		const routeWrite = (stream, originalWrite, streamName) => {
			const write = originalWrite.bind(stream);
			return (chunk, encoding, callback) => {
				if (!this.#hooks) return write(chunk, encoding, callback);
				const callbackValue = typeof encoding === "function" ? encoding : callback;
				const encodingValue = typeof encoding === "string" ? encoding : undefined;
				this.#emitText(streamName, chunkToString(chunk, encodingValue));
				if (typeof callbackValue === "function") callbackValue();
				return true;
			};
		};
		process.stdout.write = routeWrite(process.stdout, originalStdoutWrite, "stdout");
		process.stderr.write = routeWrite(process.stderr, originalStderrWrite, "stderr");
		console.log = (...values) => this.#emitText("stdout", `${values.map(formatValue).join(" ")}\n`);
		console.error = (...values) => this.#emitText("stderr", `${values.map(formatValue).join(" ")}\n`);
		globalThis.__senpi_restore_console__ = () => {
			console.log = originalLog;
			console.error = originalError;
			process.stdout.write = originalStdoutWrite;
			process.stderr.write = originalStderrWrite;
		};
	}

	#emitText(stream, data) {
		this.#hooks?.emit({ type: "text", stream, data });
	}

	#emitStatus(event) {
		this.#hooks?.emit({ type: "status", event });
	}

	#display(value) {
		if (value && typeof value === "object") {
			if (value.type === "markdown" && typeof value.text === "string") {
				this.#hooks?.emit({ type: "display", mimeType: "text/markdown", dataBase64: encodeBase64(value.text) });
				return;
			}
			if (value.type === "image" && typeof value.mimeType === "string") {
				const dataBase64 = imageBase64(value.data);
				if (dataBase64 !== undefined) {
					this.#hooks?.emit({ type: "display", mimeType: value.mimeType, dataBase64 });
					return;
				}
				this.#emitText(
					"stdout",
					`[display: image dropped — \`data\` must be a base64 string, Uint8Array/Buffer, or ArrayBuffer; got ${describeImageData(value.data)}]\n`,
				);
				return;
			}
			if (typeof value.mimeType === "string" && typeof value.dataBase64 === "string") {
				this.#hooks?.emit({ type: "display", mimeType: value.mimeType, dataBase64: value.dataBase64 });
				return;
			}
			try {
				this.#hooks?.emit({ type: "display", mimeType: "application/json", dataBase64: encodeBase64(JSON.stringify(value)) });
			} catch (error) {
				if (!(error instanceof TypeError)) throw error;
				this.#emitText("stdout", `${inspect(value, { colors: false, depth: 5 })}\n`);
			}
			return;
		}
		this.#emitText("stdout", `${String(value)}\n`);
	}

	#envHelper(key, value) {
		if (key === undefined || key === null || key === "") {
			const merged = Object.fromEntries(Object.entries({ ...process.env, ...Object.fromEntries(this.#env) }).sort());
			this.#emitStatus({ op: "env", count: Object.keys(merged).length, keys: Object.keys(merged).slice(0, 20) });
			return merged;
		}
		const name = String(key);
		if (value !== undefined) {
			const stringValue = String(value);
			this.#env.set(name, stringValue);
			this.#emitStatus({ op: "env", key: name, value: stringValue, action: "set" });
			return stringValue;
		}
		const result = this.#env.get(name) ?? process.env[name];
		this.#emitStatus({ op: "env", key: name, value: result, action: "get" });
		return result;
	}

	async #read(rawPath, options) {
		const path = this.#resolvePath(String(rawPath), "read");
		const info = await stat(path);
		if (info.isDirectory()) throw new Error(`Directory paths are not supported by read(): ${path}`);
		let text = await readFile(path, "utf8");
		const offset = typeof options.offset === "number" ? options.offset : 1;
		const limit = typeof options.limit === "number" ? options.limit : undefined;
		if (offset > 1 || limit !== undefined) {
			const lines = text.split(/\r?\n/u);
			const start = Math.max(0, offset - 1);
			text = lines.slice(start, limit === undefined ? undefined : start + limit).join("\n");
		}
		this.#emitStatus({ op: "read", path, bytes: info.size, chars: text.length });
		return text;
	}

	async #write(rawPath, content) {
		const path = this.#resolvePath(String(rawPath), "write");
		const data = await writeData(content);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, data);
		this.#emitStatus({ op: "write", path, bytes: typeof data === "string" ? Buffer.byteLength(data) : data.byteLength });
		return path;
	}

	#resolvePath(rawPath, operation) {
		const match = INTERNAL_URL.exec(rawPath);
		if (!match) return isAbsolute(rawPath) ? normalize(rawPath) : resolve(this.#cwd, rawPath);
		const scheme = match[1].toLowerCase();
		const root = this.#localRoots[scheme];
		if (!root) throw new Error(`Protocol paths are not supported by ${operation}(): ${rawPath}`);
		let relative;
		try {
			relative = decodeURIComponent(match[2].replaceAll("\\", "/"));
		} catch (error) {
			if (error instanceof URIError) throw new Error(`Invalid URL encoding in ${scheme}:// path: ${rawPath}`);
			throw error;
		}
		if (isAbsolute(relative) || relative.split("/").includes("..")) {
			throw new Error(`Path traversal is not allowed in ${scheme}:// URLs: ${rawPath}`);
		}
		const rootPath = resolve(root);
		const path = resolve(rootPath, relative);
		if (path !== rootPath && !path.startsWith(`${rootPath}${sep}`)) throw new Error(`${scheme}:// path escapes its root`);
		return path;
	}

	async #output(args) {
		let ids = args;
		let options = {};
		const last = args.at(-1);
		if (isPlainObject(last)) {
			ids = args.slice(0, -1);
			options = last;
		}
		return await this.#callTool(reservedTool("__senpi_reserved_output_tool__", "output"), {
			ids: ids.map(String),
			...options,
		});
	}

	async #agent(prompt, options, rest) {
		const parsed = optionsArg({
			name: "agent",
			value: options,
			rest,
			keys: ["agent", "model", "label", "schema", "isolated", "apply", "merge"],
			example: "{ agent, model, label, schema, isolated, apply, merge, handle }",
		});
		const { handle, ...callArgs } = parsed;
		const response = await this.#callTool(reservedTool("__senpi_reserved_agent_tool__", "agent"), {
			prompt: String(prompt),
			...callArgs,
			handle: Boolean(handle),
		});
		const responseRecord = isPlainObject(response) ? response : {};
		const text = Object.hasOwn(responseRecord, "text") ? responseRecord.text : response;
		const output = Object.hasOwn(callArgs, "schema")
			? Object.hasOwn(responseRecord, "data")
				? responseRecord.data
				: JSON.parse(String(text))
			: text;
		if (!handle) return output;
		const details = isPlainObject(responseRecord.details) ? responseRecord.details : responseRecord;
		const id = details.id;
		if (id === undefined || id === null) return { text, output: text, handle: null, id: null, agent: null };
		const node = {
			text,
			output: text,
			handle: details.handle ?? `agent://${id}`,
			id,
			agent: details.agent ?? callArgs.agent ?? null,
		};
		if (Object.hasOwn(callArgs, "schema")) node.data = output;
		for (const key of ["isolated", "patchPath", "branchName", "nestedPatches", "changesApplied", "isolationSummary"]) {
			if (details[key] !== undefined) node[key] = details[key];
		}
		return node;
	}

	async #callTool(toolName, args) {
		const hooks = this.#hooks;
		if (!hooks) throw new Error("tool call outside active JS cell");
		if (
			typeof globalThis.__senpi_timeout_pause_op__ !== "string" ||
			typeof globalThis.__senpi_timeout_resume_op__ !== "string"
		) {
			throw new Error("timeout bridge is unavailable");
		}
		this.#emitStatus({ op: globalThis.__senpi_timeout_pause_op__ });
		try {
			return await hooks.callTool(toolName, args);
		} finally {
			this.#emitStatus({ op: globalThis.__senpi_timeout_resume_op__ });
		}
	}

	async #parallel(thunks) {
		const list = Array.from(thunks ?? []);
		if (list.length === 0) return [];
		const configuredWidth = Number.isFinite(this.#parallelPoolWidth) ? Math.trunc(this.#parallelPoolWidth) : 1;
		const workerCount = Math.min(Math.max(1, configuredWidth), list.length);
		const results = new Array(list.length);
		let next = 0;
		let firstError;
		let firstErrorIndex = list.length;
		let hasError = false;
		const worker = async () => {
			while (true) {
				const index = next;
				next += 1;
				if (index >= list.length) return;
				try {
					const thunk = list[index];
					if (typeof thunk !== "function") throw new TypeError("parallel() expects an iterable of functions");
					results[index] = await thunk(index);
				} catch (error) {
					if (!hasError || index < firstErrorIndex) {
						hasError = true;
						firstErrorIndex = index;
						firstError = error;
					}
				}
			}
		};
		await Promise.all(Array.from({ length: workerCount }, worker));
		if (hasError) throw firstError;
		return results;
	}

	async #pipeline(items, stages) {
		let current = Array.from(items ?? []);
		for (const stage of stages) {
			if (typeof stage !== "function") throw new TypeError("pipeline() stages must be functions");
			current = await this.#parallel(current.map(item => async () => await stage(item)));
		}
		return current;
	}
}

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionsArg(options) {
	const { name, value, rest, keys, example } = options;
	if (isPlainObject(value)) {
		if (rest.some(item => item !== undefined && item !== null)) throw new TypeError(`${name}() options cannot mix object and positional forms`);
		return value;
	}
	const values = [value, ...rest];
	for (let index = keys.length; index < values.length; index += 1) {
		if (values[index] !== undefined && values[index] !== null) throw new TypeError(`${name}() accepts ${example}`);
	}
	return Object.fromEntries(keys.flatMap((key, index) => values[index] === undefined || values[index] === null ? [] : [[key, values[index]]]));
}

function helperOptions(name, value, rest) {
	return optionsArg({ name, value, rest, keys: ["offset", "limit"], example: "{ offset, limit }" });
}

function reservedTool(globalName, helperName) {
	const value = globalThis[globalName];
	if (typeof value !== "string") throw new Error(`${helperName}() bridge is unavailable`);
	return value;
}

async function writeData(value) {
	if (typeof value === "string" || value instanceof Uint8Array) return value;
	if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	throw new TypeError("write() expects string, Blob, ArrayBuffer, or TypedArray data");
}

function imageBase64(data) {
	if (typeof data === "string") {
		if (isStrictBase64(data)) return data;
		if (!DECIMAL_CSV_RE.test(data)) return undefined;
		const parts = data.split(",");
		const bytes = new Uint8Array(parts.length);
		for (let index = 0; index < parts.length; index += 1) {
			const byte = Number(parts[index]);
			if (!Number.isInteger(byte) || byte < 0 || byte > 255) return undefined;
			bytes[index] = byte;
		}
		return Buffer.from(bytes).toString("base64");
	}
	if (data instanceof Uint8Array) return Buffer.from(data).toString("base64");
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString("base64");
	if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64");
	if (isPlainObject(data) && data.type === "Buffer" && Array.isArray(data.data)) {
		const bytes = new Uint8Array(data.data.length);
		for (let index = 0; index < data.data.length; index += 1) {
			const byte = data.data[index];
			if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) return undefined;
			bytes[index] = byte;
		}
		return Buffer.from(bytes).toString("base64");
	}
	return undefined;
}

function isStrictBase64(value) {
	return value.length > 0 && value.length % 4 === 0 && BASE64_STRICT_RE.test(value);
}

function describeImageData(data) {
	if (data === null) return "null";
	if (data instanceof Uint8Array) return "Uint8Array";
	if (data instanceof ArrayBuffer) return "ArrayBuffer";
	if (ArrayBuffer.isView(data)) return data.constructor.name;
	if (typeof data === "string") return `string(${data.length})`;
	return typeof data;
}

function chunkToString(chunk, encoding) {
	if (typeof chunk === "string") return chunk;
	if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString(encoding ?? "utf8");
	return String(chunk);
}

function encodeBase64(value) {
	return Buffer.from(value, "utf8").toString("base64");
}

function formatValue(value) {
	return typeof value === "string" ? value : inspect(value, { colors: false, depth: 5 });
}
