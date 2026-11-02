import { TEARDOWN_TIMEOUT_MS } from "./tui-resume-args.mjs";

export function waitForPtyExit(exitPromise, timeoutMs, timers = {}) {
	const schedule = timers.schedule ?? setTimeout;
	const unschedule = timers.unschedule ?? clearTimeout;
	return new Promise((resolve) => {
		const timer = schedule(() => resolve({ timeout: true }), timeoutMs);
		exitPromise.then(
			(event) => {
				unschedule(timer);
				resolve({ event });
			},
			(error) => {
				unschedule(timer);
				resolve({ error });
			},
		);
	});
}

export function sendSigkillTree({ pid, term, platform, killProcess = process.kill.bind(process) }) {
	const result = { groupKillAttempted: false, sigkillAttempted: true };
	if (platform !== "win32" && Number.isInteger(pid) && pid > 0) {
		result.groupKillAttempted = true;
		try {
			killProcess(-pid, "SIGKILL");
		} catch (error) {
			result.groupKillError = error instanceof Error ? error.message : String(error);
		}
	} else if (platform === "win32" && Number.isInteger(pid) && pid > 0) {
		try {
			killProcess(pid, "SIGKILL");
		} catch (error) {
			result.pidKillError = error instanceof Error ? error.message : String(error);
		}
	}
	try {
		if (platform === "win32") term.kill();
		else term.kill("SIGKILL");
	} catch (error) {
		result.termKillError = error instanceof Error ? error.message : String(error);
	}
	return result;
}

function applyExitEvent(receipt, event) {
	receipt.ptyExited = true;
	receipt.exitCode = event.exitCode ?? null;
	receipt.signal = event.signal ?? null;
}

export async function teardownPty(term, stream, hooks = {}) {
	const waitExit = hooks.waitExit ?? ((timeoutMs) => waitForPtyExit(stream.exitPromise, timeoutMs));
	const killProcess = hooks.killProcess ?? process.kill.bind(process);
	const platform = hooks.platform ?? process.platform;
	const timeoutMs = hooks.timeoutMs ?? TEARDOWN_TIMEOUT_MS;
	const receipt = {
		pid: term.pid ?? null,
		killAttempted: false,
		alreadyExited: !!stream.exit,
		ptyExited: false,
		exitCode: null,
		signal: null,
		escalated: false,
	};
	if (stream.exit) {
		applyExitEvent(receipt, stream.exit);
		return receipt;
	}
	receipt.killAttempted = true;
	try {
		term.write("\x03\x03");
		term.kill();
	} catch (error) {
		receipt.killError = error instanceof Error ? error.message : String(error);
	}
	let outcome = await waitExit(timeoutMs);
	if (outcome.event) {
		applyExitEvent(receipt, outcome.event);
		return receipt;
	}
	receipt.timeout = true;
	receipt.escalated = true;
	Object.assign(receipt, sendSigkillTree({ pid: receipt.pid, term, platform, killProcess }));
	outcome = await waitExit(timeoutMs);
	if (outcome.event) {
		applyExitEvent(receipt, outcome.event);
		return receipt;
	}
	const error = new Error(`PTY exit not confirmed after SIGKILL (pid=${receipt.pid})`);
	error.receipt = receipt;
	throw error;
}

export function applyPostExitCleanup(receipt, hooks) {
	receipt.cleanupSequence = [];
	if (receipt.ptyExited) {
		receipt.cleanupSequence.push("ptyExited");
		hooks.removeSandbox();
		receipt.sandboxRemoved = !hooks.sandboxExists();
		if (receipt.sandboxRemoved) receipt.cleanupSequence.push("sandboxRemoved");
	} else {
		receipt.sandboxRemoved = false;
	}
	try {
		receipt.authUnchanged = hooks.assertAuth();
		if (receipt.ptyExited && receipt.authUnchanged) receipt.cleanupSequence.push("authUnchanged");
	} catch (error) {
		receipt.authUnchanged = false;
		receipt.authError = error instanceof Error ? error.message : String(error);
	}
	receipt.summary =
		receipt.ptyExited && receipt.sandboxRemoved ? "PTY exited and sandbox removed" : "cleanup incomplete";
	return receipt;
}
