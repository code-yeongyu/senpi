// senpi#3685, #3694: the race window between claiming a tool-child socket root and the first write into it, injected at
// the fs layer so the same tests drive every version of the claim. A `windows` hook runs once per root, at the first
// write that targets it: the secret file's write (an old claim) or its create (the current one). `onSocketRemoval`
// runs before every removal of a `.sock` path. `order` records the secret writes and the socket removals.
import type * as FsPromises from "node:fs/promises";
import { dirname } from "node:path";

export interface SocketRootWindow {
	windows: Array<(root: string) => Promise<void>>;
	onSocketRemoval: ((socketPath: string) => Promise<void>) | undefined;
	order: string[];
	fired: Set<string>;
}

export const socketRootWindow: SocketRootWindow = {
	windows: [],
	onSocketRemoval: undefined,
	order: [],
	fired: new Set(),
};

export function resetSocketRootWindow(): void {
	socketRootWindow.windows = [];
	socketRootWindow.onSocketRemoval = undefined;
	socketRootWindow.order = [];
	socketRootWindow.fired = new Set();
}

async function openWindow(root: string): Promise<void> {
	if (socketRootWindow.fired.has(root)) return;
	const hook = socketRootWindow.windows.shift();
	if (hook === undefined) return;
	socketRootWindow.fired.add(root);
	await hook(root);
}

const isSecret = (path: unknown): boolean => String(path).endsWith(".sock.secret");

export function withSocketRootWindow(fs: typeof FsPromises): typeof FsPromises {
	return {
		...fs,
		writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
			if (isSecret(args[0])) await openWindow(dirname(String(args[0])));
			await fs.writeFile(...args);
			if (isSecret(args[0])) socketRootWindow.order.push("secret");
		},
		open: async (...args: Parameters<typeof fs.open>) => {
			const creating = isSecret(args[0]) && typeof args[1] === "number";
			if (creating) await openWindow(dirname(String(args[0])));
			const handle = await fs.open(...args);
			if (creating) socketRootWindow.order.push("secret");
			return handle;
		},
		rm: async (...args: Parameters<typeof fs.rm>) => {
			if (String(args[0]).endsWith(".sock")) {
				socketRootWindow.order.push("rm-socket");
				await socketRootWindow.onSocketRemoval?.(String(args[0]));
			}
			return fs.rm(...args);
		},
	};
}
