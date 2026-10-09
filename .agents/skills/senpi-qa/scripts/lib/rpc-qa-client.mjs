import { spawnCli } from "./common.mjs";

export class RpcQaClient {
	constructor({ env, cwd, extraArgs, spawnCli: spawnChild = spawnCli }) {
		this.child = spawnChild(["--mode", "rpc", "--no-session", "--no-context-files", ...extraArgs], { env, cwd });
		this.pending = new Map();
		this.events = [];
		this.eventWaiters = [];
		this.stderr = "";
		this.buffer = "";
		this.sequence = 0;
		this.child.stdout.on("data", (chunk) => this.onData(chunk));
		this.child.stderr.on("data", (chunk) => {
			this.stderr += chunk.toString();
		});
	}

	onData(chunk) {
		this.buffer += chunk.toString();
		let newline = this.buffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (line) this.onLine(line);
			newline = this.buffer.indexOf("\n");
		}
	}

	onLine(line) {
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			this.stderr += `[ignored non-protocol stdout] ${line.slice(0, 200)}\n`;
			return;
		}
		if (message.type === "response") {
			const waiter = this.pending.get(message.id);
			if (!waiter) return;
			clearTimeout(waiter.timer);
			this.pending.delete(message.id);
			waiter.resolve(message);
			return;
		}
		if (!message.type) return;
		this.events.push(message);
		const eventIndex = this.events.length - 1;
		for (const waiter of [...this.eventWaiters]) {
			if (eventIndex < waiter.afterIndex || !waiter.predicate(message)) continue;
			clearTimeout(waiter.timer);
			this.eventWaiters.splice(this.eventWaiters.indexOf(waiter), 1);
			waiter.resolve(message);
		}
	}

	send(command, timeoutMs = 15_000) {
		const id = `qa-${++this.sequence}`;
		return new Promise((resolveResponse, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`RPC response timeout for ${command.type}: ${this.stderr.slice(-400)}`));
			}, timeoutMs);
			this.pending.set(id, { resolve: resolveResponse, timer });
			this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		});
	}

	waitForEvent(predicate, afterIndex, timeoutMs = 15_000) {
		const found = this.events.slice(afterIndex).find(predicate);
		if (found) return Promise.resolve(found);
		return new Promise((resolveEvent, reject) => {
			const waiter = {
				afterIndex,
				predicate,
				resolve: resolveEvent,
				timer: setTimeout(() => {
					this.eventWaiters.splice(this.eventWaiters.indexOf(waiter), 1);
					reject(new Error(`RPC event timeout: ${this.stderr.slice(-400)}`));
				}, timeoutMs),
			};
			this.eventWaiters.push(waiter);
		});
	}

	close() {
		this.child.stdin.end();
	}

	kill() {
		this.child.kill("SIGKILL");
	}

	waitForExit(timeoutMs = 5_000) {
		if (this.child.exitCode !== null) return Promise.resolve(this.child.exitCode);
		return new Promise((resolveExit, reject) => {
			const timer = setTimeout(() => reject(new Error("RPC process did not exit after stdin closed")), timeoutMs);
			this.child.once("close", (code) => {
				clearTimeout(timer);
				resolveExit(code);
			});
		});
	}
}
