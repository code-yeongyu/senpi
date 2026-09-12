export function createResumeCleanupController({
	processLike = process,
	exit = (code) => processLike.exit(code),
	teardown,
	postExitCleanup,
	prePtyCleanup = () => null,
}) {
	let pty;
	let cleanupPromise;
	let installed = false;
	let signalHandled = false;
	let signalCompletion = Promise.resolve();

	async function cleanup() {
		if (!cleanupPromise) {
			cleanupPromise = (async () => {
				if (!pty) return prePtyCleanup();
				let receipt;
				try {
					receipt = await teardown(pty.term, pty.stream);
				} catch (error) {
					receipt = error.receipt ?? { ptyExited: false };
					receipt.teardownError = error instanceof Error ? error.message : String(error);
				}
				return postExitCleanup(receipt);
			})();
		}
		return cleanupPromise;
	}

	function handleSignal(signal) {
		if (signalHandled) return signalCompletion;
		signalHandled = true;
		signalCompletion = cleanup().then(() => exit(signal === "SIGTERM" ? 143 : 130));
		return signalCompletion;
	}

	function unregister() {
		if (!installed || typeof processLike.off !== "function") return;
		processLike.off("SIGINT", onSigint);
		processLike.off("SIGTERM", onSigterm);
		installed = false;
	}

	const onSigint = () => void handleSignal("SIGINT");
	const onSigterm = () => void handleSignal("SIGTERM");

	function installStable() {
		if (installed) return;
		installed = true;
		processLike.on("SIGINT", onSigint);
		processLike.on("SIGTERM", onSigterm);
	}

	return {
		registerPty(term, stream) {
			pty = { term, stream };
		},
		install: installStable,
		unregister,
		cleanup,
		get signalCompletion() {
			return signalCompletion;
		},
	};
}
