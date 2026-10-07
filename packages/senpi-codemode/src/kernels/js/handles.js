// In-cell `wait()` / `handle()` over the host's handle capability. Mirrors src/bridge/reserved.ts; this
// worker asset cannot import TypeScript. Every call rides the ordinary bridge-call path (`callTool`), so
// the run budget pauses while the cell is parked and the hard limit still applies.
const RESERVED_WAIT_TOOL = "__wait__";
const RESERVED_HANDLE_STATUS_TOOL = "__handle_status__";
const RESERVED_HANDLE_OUTPUT_TOOL = "__handle_output__";
const RESERVED_HANDLE_SEND_TOOL = "__handle_send__";
const RESERVED_HANDLE_CANCEL_TOOL = "__handle_cancel__";
const KINDS = new Set(["agent", "completion", "workpool"]);
const WAIT_MODES = new Set(["all", "any", "settled"]);
const USAGE = "handle() expects an agent(..., {handle: true}) record, a workpool, a completion handle, or a saved {kind, id, run_epoch} reference";

export function createHandleHelpers(callTool) {
	const wait = async (handles, options) => {
		const list = Array.isArray(handles) ? handles : handles === undefined || handles === null ? [] : [handles];
		const refs = list.map(toHandleRef);
		const { timeout, mode } = waitOptions(options);
		return await callTool(RESERVED_WAIT_TOOL, {
			refs,
			...(timeout === undefined ? {} : { timeout }),
			...(mode === undefined ? {} : { mode }),
		});
	};
	const handle = value => {
		const ref = toHandleRef(value);
		const view = Object.create(Object.prototype);
		if (isPlainObject(value)) {
			for (const [key, field] of Object.entries(value)) {
				if (typeof field !== "function") view[key] = field;
			}
		}
		if (!Object.hasOwn(view, "id")) view.id = ref.id;
		if (!Object.hasOwn(view, "run_epoch")) view.run_epoch = ref.run_epoch;
		if (!Object.hasOwn(view, "handle")) view.handle = `${ref.kind}://${ref.id}`;
		const control = Object.freeze({
			status: async () => await callTool(RESERVED_HANDLE_STATUS_TOOL, { ref }),
			output: async (opts = {}) => await callTool(RESERVED_HANDLE_OUTPUT_TOOL, { ref, ...outputOptions(opts) }),
			send: async message => await callTool(RESERVED_HANDLE_SEND_TOOL, { ref, message: String(message) }),
			cancel: async () => await callTool(RESERVED_HANDLE_CANCEL_TOOL, { ref }),
			wait: async (opts = {}) => (await wait([ref], { ...waitOptions(opts), mode: "all" }))[0],
		});
		Object.defineProperty(view, "ref", { value: Object.freeze({ ...ref }), enumerable: false });
		Object.defineProperty(view, "control", { value: control, enumerable: false });
		return view;
	};
	return { wait, handle };
}

/** Accepts legacy agent records, handle() views, completion handles, workpools and saved refs. */
export function toHandleRef(value) {
	if (!isPlainObject(value)) throw new TypeError(USAGE);
	if (isPlainObject(value.ref) && KINDS.has(value.ref.kind)) return toHandleRef(value.ref);
	if (typeof value.pool_id === "string") return { kind: "workpool", id: value.pool_id, run_epoch: 0 };
	const kind = KINDS.has(value.kind) ? value.kind : kindFromHandle(value.handle);
	const id = value.id ?? value.task_id;
	if (kind === undefined || typeof id !== "string" || id.length === 0) throw new TypeError(USAGE);
	const run_epoch = value.run_epoch ?? (kind === "workpool" ? 0 : undefined);
	if (!Number.isInteger(run_epoch) || run_epoch < 0) throw new TypeError(`${USAGE}; run_epoch must be a non-negative integer`);
	return { kind, id, run_epoch };
}

function kindFromHandle(handle) {
	if (typeof handle !== "string") return undefined;
	const scheme = handle.split("://")[0];
	return KINDS.has(scheme) ? scheme : undefined;
}

function waitOptions(options) {
	if (options === undefined || options === null) return {};
	if (!isPlainObject(options)) throw new TypeError("wait() accepts { timeout, mode }");
	for (const key of Object.keys(options)) {
		if (key !== "timeout" && key !== "mode") throw new TypeError("wait() accepts { timeout, mode }");
	}
	const { timeout, mode } = options;
	if (timeout !== undefined && timeout !== null && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0)) {
		throw new TypeError("wait() timeout must be a finite number of seconds >= 0");
	}
	if (mode !== undefined && mode !== null && !WAIT_MODES.has(mode)) throw new TypeError('wait() mode must be "all", "any" or "settled"');
	return { ...(timeout === undefined || timeout === null ? {} : { timeout }), ...(mode === undefined || mode === null ? {} : { mode }) };
}

function outputOptions(options) {
	if (!isPlainObject(options)) throw new TypeError("control.output() accepts { format, offset, limit }");
	const picked = {};
	for (const key of ["format", "offset", "limit"]) {
		if (options[key] !== undefined && options[key] !== null) picked[key] = options[key];
	}
	return picked;
}

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
