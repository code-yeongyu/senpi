const COUNT = 4;
const REGION = 16 * 1024;
const STRIDE = 12 + REGION * 2;
const FREE = 0, REQUESTED = 1, WRITING = 2, ANSWERED = 3, ABANDONED = 4, INTERRUPTED = 5;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function createPermissionSlots() {
	return new SharedArrayBuffer(COUNT * STRIDE);
}

function slotViews(buffer, index) {
	if (buffer.byteLength !== COUNT * STRIDE || !Number.isInteger(index) || index < 0 || index >= COUNT) {
		throw new Error("Invalid permission slot");
	}
	const offset = index * STRIDE;
	return {
		control: new Int32Array(buffer, offset, 3),
		request: new Uint8Array(buffer, offset + 12, REGION),
		response: new Uint8Array(buffer, offset + 12 + REGION, REGION),
	};
}

export function permissionControl(buffer, index) {
	return Atomics.load(slotViews(buffer, index).control, 0);
}

export function interruptPermissionSlot(buffer, index, observed) {
	if ((observed & 7) !== REQUESTED) return false;
	const { control } = slotViews(buffer, index);
	const won = Atomics.compareExchange(control, 0, observed, (observed & ~7) | INTERRUPTED) === observed;
	if (won) Atomics.notify(control, 0);
	return won;
}

export function interruptPermissionSlots(buffer) {
	for (let index = 0; index < COUNT; index++) interruptPermissionSlot(buffer, index, permissionControl(buffer, index));
}

function encode(region, value) {
	const bytes = encoder.encode(JSON.stringify(value));
	if (bytes.length > region.length) throw new Error("Permission message exceeds slot capacity");
	region.set(bytes);
	return bytes.length;
}

function decode(region, length) {
	if (!Number.isInteger(length) || length < 1 || length > region.length) throw new Error("Invalid permission message size");
	return JSON.parse(decoder.decode(region.subarray(0, length)));
}

export function createPermissionRequester(buffer, hooks) {
	let generation = 0;
	let retired = false;
	return {
		check(request) {
			if (retired || generation >= (hooks.generationLimit ?? 2 ** 28)) {
				if (!retired) { retired = true; hooks.retire?.(); }
				throw new Error("Permission worker generation exhausted");
			}
			generation++;
			for (let index = 0; index < COUNT; index++) {
				const { control, request: region, response } = slotViews(buffer, index);
				const old = Atomics.load(control, 0);
				if (![FREE, ANSWERED, ABANDONED].includes(old & 7)) continue;
				control[1] = encode(region, request);
				const requested = (generation << 3) | REQUESTED;
				if (Atomics.compareExchange(control, 0, old, requested) !== old) throw new Error("Permission slot ownership changed");
				try {
					hooks.wake(index, generation);
					(hooks.wait ?? Atomics.wait)(control, 0, requested, 2000);
					const current = Atomics.load(control, 0);
					if (current === ((generation << 3) | ANSWERED)) {
						const result = decode(response, control[2]);
						if (result?.action === "pass") return result;
						if (result?.action === "deny" && validRule(result.rule)) return result;
						throw new Error("Invalid permission answer");
					}
					throw new Error("Permission check interrupted or timed out");
				} finally {
					// A WRITING slot belongs to the host even when the worker's deadline has expired.
					Atomics.compareExchange(control, 0, requested, (generation << 3) | ABANDONED);
					Atomics.compareExchange(control, 0, (generation << 3) | INTERRUPTED, (generation << 3) | ABANDONED);
				}
			}
			throw new Error("No permission slot available");
		},
	};
}

function validRule(rule) {
	return rule !== null && typeof rule === "object" &&
		typeof rule.permission === "string" && typeof rule.pattern === "string" && typeof rule.layer === "string";
}

export function servePermissionSlot(buffer, index, generation, decide, hooks = {}) {
	const { control, request, response } = slotViews(buffer, index);
	const requested = (generation << 3) | REQUESTED;
	// Own the request bytes before reading them; an abandoned slot may otherwise be rewritten mid-decode.
	if (Atomics.compareExchange(control, 0, requested, (generation << 3) | WRITING) !== requested) return Promise.resolve();
	const finish = async (answer) => {
		try {
			control[2] = encode(response, answer);
		} catch {
			control[2] = encode(response, { action: "error" });
		}
		Atomics.compareExchange(control, 0, (generation << 3) | WRITING, (generation << 3) | ANSWERED);
		Atomics.notify(control, 0);
	};
	const evaluate = () => {
		try {
			const result = decide(decode(request, control[1]));
			return result instanceof Promise
				? result.then(finish, () => finish({ action: "error" }))
				: finish(result);
		} catch {
			return finish({ action: "error" });
		}
	};
	try {
		const pending = hooks.claimed?.();
		return pending ? pending.then(evaluate, () => finish({ action: "error" })) : evaluate();
	} catch { return finish({ action: "error" }); }
}
