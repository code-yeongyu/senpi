/**
 * The authority word of a host-mode delegated connection (omo-relay-daemon#307).
 *
 * One `Int32Array(SharedArrayBuffer(8))` per incarnation of a delegated socket: index 0 packs
 * `epoch << 4 | retired << 3 | mask` (mask bit 0 = interactive_user, bit 1 = task_parent, bit 2 = peer_agent), index 1 is
 * the incarnation,
 * stamped once before the buffer is shared. The host thread is the only writer, and every write is monotone within a
 * word: mask bits are only cleared, retired is only set, the epoch only grows and changes only on a real transition.
 * Host and worker threads read the same memory with one `Atomics.load` per command, so the load at a command's first
 * role check is its admission and the host's store is the revocation point.
 *
 * This module has no package imports on purpose: worker-thread tests load it directly.
 */

/** The roles a word can carry, in bit order. */
const WORD_ROLES = ["interactive_user", "task_parent", "peer_agent"] as const;
const MASK_BITS = 7;
const RETIRED_BIT = 8;
const EPOCH_SHIFT = 4;
/** The epoch field holds 28 bits; within one incarnation it never passes 4, so this bound is an invariant check. */
const EPOCH_LIMIT = 2 ** 28;

/** The largest incarnation slot [1] holds unchanged. */
export const INCARNATION_MAX = 0x7fffffff;

export interface AuthorityState {
	readonly epoch: number;
	readonly retired: boolean;
	readonly mask: number;
	readonly roles: readonly string[];
}

export function maskOfRoles(roles: Iterable<string>): number {
	let mask = 0;
	for (const role of roles) {
		const bit = WORD_ROLES.indexOf(role as (typeof WORD_ROLES)[number]);
		if (bit >= 0) mask |= 1 << bit;
	}
	return mask;
}

export function rolesOfMask(mask: number): string[] {
	return WORD_ROLES.filter((_role, bit) => (mask & (1 << bit)) !== 0);
}

export function decodeWord(word: number): AuthorityState {
	const mask = word & MASK_BITS;
	return { epoch: word >>> EPOCH_SHIFT, retired: (word & RETIRED_BIT) !== 0, mask, roles: rolesOfMask(mask) };
}

function packWord(epoch: number, retired: boolean, mask: number): number {
	if (!Number.isSafeInteger(epoch) || epoch < 1 || epoch >= EPOCH_LIMIT) throw new Error("authority_epoch_exhausted");
	return (epoch << EPOCH_SHIFT) | (retired ? RETIRED_BIT : 0) | mask;
}

/** A new incarnation's word: epoch 1, not retired, `mask`, with `incarnation` stamped before anything shares it. */
export function createAuthority(incarnation: number, mask: number): SharedArrayBuffer {
	if (!Number.isSafeInteger(incarnation) || incarnation < 1 || incarnation > INCARNATION_MAX)
		throw new Error("authority_incarnation_invalid");
	const buffer = new SharedArrayBuffer(8);
	const view = new Int32Array(buffer);
	view[0] = packWord(1, false, mask & MASK_BITS);
	view[1] = incarnation;
	return buffer;
}

export function readAuthority(buffer: SharedArrayBuffer): AuthorityState {
	return decodeWord(Atomics.load(new Int32Array(buffer), 0));
}

export function incarnationOf(buffer: SharedArrayBuffer): number {
	return Atomics.load(new Int32Array(buffer), 1);
}

function store(view: Int32Array, word: number): void {
	Atomics.store(view, 0, word);
	Atomics.notify(view, 0);
}

/** Host thread only: mask ← mask ∩ roles. The epoch moves only when a bit cleared; true when it did. */
export function storeNarrowed(buffer: SharedArrayBuffer, roles: Iterable<string>): boolean {
	const view = new Int32Array(buffer);
	const current = decodeWord(Atomics.load(view, 0));
	const mask = current.mask & maskOfRoles(roles);
	if (mask === current.mask) return false;
	store(view, packWord(current.epoch + 1, current.retired, mask));
	return true;
}

/** Host thread only: sets retired and moves the epoch; a word already retired is left as it is (false). */
export function storeRetired(buffer: SharedArrayBuffer): boolean {
	const view = new Int32Array(buffer);
	const current = decodeWord(Atomics.load(view, 0));
	if (current.retired) return false;
	store(view, packWord(current.epoch + 1, true, current.mask));
	return true;
}

/** The successor of incarnation `k`, checked BEFORE any stamp; undefined once the counter is exhausted (never wraps). */
export function nextIncarnation(k: number, max = INCARNATION_MAX): number | undefined {
	return Number.isSafeInteger(k) && k >= 1 && k < max ? k + 1 : undefined;
}

/** Whether a word admits `role` for a claim: claimed, not retired, and still in the mask. */
export function effectiveRoles(claim: readonly string[] | undefined, state: AuthorityState): string[] {
	if (state.retired || claim === undefined) return [];
	return claim.filter((role) => state.roles.includes(role));
}
