interface SessionKernel {
	revoke(): void;
	retire(): Promise<void>;
}

export interface PermissionSession {
	dead: boolean;
	pending?: Promise<void>;
	readonly kernels: Set<SessionKernel>;
}

const sessions = new Map<string, PermissionSession>();

export function registerPermissionKernel(sessionId: string, kernel: SessionKernel): PermissionSession {
	let session = sessions.get(sessionId);
	if (!session) {
		session = { dead: false, kernels: new Set() };
		sessions.set(sessionId, session);
	}
	session.kernels.add(kernel);
	return session;
}

export function unregisterPermissionKernel(sessionId: string, kernel: SessionKernel): void {
	const session = sessions.get(sessionId);
	if (!session) return;
	session.kernels.delete(kernel);
	if (!session.dead && !session.pending && session.kernels.size === 0) sessions.delete(sessionId);
}

/** All words go DEAD synchronously, before retirement or another admission can run. */
export function revokeSessionKernels(sessionId: string): Promise<void> {
	const session = sessions.get(sessionId);
	if (!session) return Promise.resolve();
	if (session.pending) return session.pending;
	const kernels = [...session.kernels];
	for (const kernel of kernels) kernel.revoke();
	const pending = Promise.all(kernels.map((kernel) => kernel.retire())).then(() => {});
	session.pending = pending;
	void pending
		.finally(() => {
			if (session.pending === pending) session.pending = undefined;
		})
		.catch(() => {});
	return pending;
}
