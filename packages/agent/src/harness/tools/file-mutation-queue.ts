import type { Context } from "../context.ts";
import type { ExecutionEnv } from "../types.ts";
import { getOrThrow } from "../types.ts";

type MutationQueueState = {
	queues: Map<string, Promise<void>>;
	registration: Promise<void>;
};

const states = new WeakMap<ExecutionEnv, MutationQueueState>();

function getState(env: ExecutionEnv): MutationQueueState {
	let state = states.get(env);
	if (!state) {
		state = { queues: new Map(), registration: Promise.resolve() };
		states.set(env, state);
	}
	return state;
}

async function getMutationQueueKey(env: ExecutionEnv, path: string, context: Context): Promise<string> {
	const absolutePath = getOrThrow(await env.absolutePath(path, context));
	return canonicalKeyPath(env, absolutePath, context);
}

/**
 * The canonical path; for a file that does not exist yet, its canonical parent joined with its name, so a write that
 * creates a file and a later mutation of it share one key even when one of them goes through a symlinked directory.
 */
async function canonicalKeyPath(env: ExecutionEnv, absolutePath: string, context: Context): Promise<string> {
	const canonicalPath = await env.canonicalPath(absolutePath, context);
	if (canonicalPath.ok) return canonicalPath.value;
	if (canonicalPath.error.code === "not_supported") return absolutePath;
	if (canonicalPath.error.code !== "not_found") throw canonicalPath.error;
	const parent = getOrThrow(await env.joinPath([absolutePath, ".."], context));
	if (parent === absolutePath || !absolutePath.startsWith(parent)) return absolutePath;
	const name = absolutePath.slice(parent.length + (/[/\\]$/.test(parent) ? 0 : 1));
	return getOrThrow(await env.joinPath([await canonicalKeyPath(env, parent, context), name], context));
}

/** Serialize file mutations targeting the same environment and canonical path. */
export async function withFileMutationQueue<T>(
	env: ExecutionEnv,
	path: string,
	fn: () => Promise<T>,
	context: Context,
): Promise<T> {
	const state = getState(env);
	const registration = state.registration.then(async () => {
		const key = await getMutationQueueKey(env, path, context);
		const currentQueue = state.queues.get(key) ?? Promise.resolve();

		let releaseNext = () => {};
		const nextQueue = new Promise<void>((resolve) => {
			releaseNext = resolve;
		});
		const chainedQueue = currentQueue.then(() => nextQueue);
		state.queues.set(key, chainedQueue);
		return { key, currentQueue, chainedQueue, releaseNext };
	});
	state.registration = registration.then(
		() => undefined,
		() => undefined,
	);

	const { key, currentQueue, chainedQueue, releaseNext } = await registration;
	await currentQueue;
	try {
		return await fn();
	} finally {
		releaseNext();
		if (state.queues.get(key) === chainedQueue) state.queues.delete(key);
	}
}
