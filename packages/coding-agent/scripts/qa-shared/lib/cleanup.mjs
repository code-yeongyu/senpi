const trackedChildren = new Map();
const trackedClosers = new Set();
const detachChildren = process.platform !== "win32";
let signalCleanupStarted = false;

export function installCleanupHooks() {
	const cleanup = () => cleanupAll();
	process.once("exit", cleanup);
	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.once(signal, () => {
			if (signalCleanupStarted) return;
			signalCleanupStarted = true;
			cleanupAllAndWait().then(
				() => process.exit(130),
				(error) => {
					process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
					process.exit(1);
				},
			);
		});
	}
}

export function cleanupAll() {
	const children = [...trackedChildren.values()];
	for (const tracked of children) {
		if (trackedChildIsAlive(tracked)) killTrackedChild(tracked, "SIGKILL");
		const { child } = tracked;
		child.stdin?.destroy();
		child.stdout?.destroy();
		child.stderr?.destroy();
		child.unref();
	}
	trackedChildren.clear();
	if (liveChildIds(children).length === 0) closeTrackedClosers();
}

export async function cleanupAllAndWait(timeoutMs = 10000) {
	const children = [...trackedChildren.values()];
	const deadline = Date.now() + timeoutMs;
	for (const tracked of children) {
		if (trackedChildIsAlive(tracked)) killTrackedChild(tracked, "SIGTERM");
	}
	const termGraceMs = Math.min(3000, Math.max(0, Math.floor(timeoutMs / 2)));
	let closed = await waitForChildrenClose(children, Math.min(deadline, Date.now() + termGraceMs));
	if (!closed) {
		for (const tracked of children) {
			if (trackedChildIsAlive(tracked)) killTrackedChild(tracked, "SIGKILL");
		}
		closed = await waitForChildrenClose(children, deadline);
	}
	if (!closed) {
		throw new Error(`Timed out waiting for child processes to close: ${liveChildIds(children).join(", ")}`);
	}
	for (const tracked of children) {
		const { child } = tracked;
		child.stdin?.destroy();
		child.stdout?.destroy();
		child.stderr?.destroy();
		child.unref();
		trackedChildren.delete(child);
	}
	closeTrackedClosers();
}

export function trackChild(child) {
	const tracked = { child, processGroupId: detachChildren ? child.pid : undefined };
	trackedChildren.set(child, tracked);
	if (!detachChildren) child.once("close", () => trackedChildren.delete(child));
}

export function trackCloser(close) {
	trackedClosers.add(close);
}

export function untrackCloser(close) {
	trackedClosers.delete(close);
}

export function shouldDetachChildren() {
	return detachChildren;
}

async function waitForChildrenClose(children, deadline) {
	while (Date.now() < deadline) {
		if (liveChildIds(children).length === 0) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return liveChildIds(children).length === 0;
}

function liveChildIds(children) {
	return children.filter(trackedChildIsAlive).map(({ child, processGroupId }) =>
		processGroupId === undefined ? String(child.pid ?? "unknown") : `pgid:${processGroupId}`,
	);
}

function trackedChildIsAlive({ child, processGroupId }) {
	if (processGroupId === undefined) return child.exitCode === null && child.signalCode === null;
	try {
		process.kill(-processGroupId, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
		if (error instanceof Error && "code" in error && error.code === "EPERM") return true;
		throw error;
	}
}

function killTrackedChild({ child, processGroupId }, signal) {
	if (processGroupId !== undefined) {
		try {
			process.kill(-processGroupId, signal);
			return;
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") {
				throw error;
			}
		}
	}
	if (child.pid === undefined) return;
	child.kill(signal);
}

function closeTrackedClosers() {
	for (const close of trackedClosers) close();
	trackedClosers.clear();
}
