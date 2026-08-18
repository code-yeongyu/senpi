// Shared JSON-lines RPC client over a spawned `--mode rpc` child.
//
// Lives in lib/ so scenario scripts can drive RPC without importing rpc-drive.mjs,
// whose module body dispatches on argv the moment it is imported.
import { spawnCli } from "./common.mjs";

/**
 * Minimal JSON-lines RPC client over a spawned `--mode rpc` child.
 * Resolves send() promises by matching the response `id`; buffers events.
 */
export class RpcClient {
	constructor({ env, cwd, extraArgs = [] } = {}) {
		this.child = spawnCli(["--mode", "rpc", "--no-session", "--no-context-files", ...extraArgs], { env, cwd });
		this.pending = new Map();
		this.events = [];
		this.eventWaiters = [];
		this.responses = [];
		this.seq = 0;
		this._buf = "";
		this.child.stdout.on("data", (chunk) => this._onData(chunk));
		this.stderr = "";
		this.child.stderr.on("data", (d) => {
			this.stderr += d.toString();
		});
	}

	_onData(chunk) {
		this._buf += chunk.toString();
		let nl;
		while ((nl = this._buf.indexOf("\n")) >= 0) {
			const line = this._buf.slice(0, nl).trim();
			this._buf = this._buf.slice(nl + 1);
			if (!line) continue;
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				continue; // non-protocol noise (tsx/startup) — ignore
			}
			if (msg && msg.type === "response") {
				this.responses.push(msg);
				const waiter = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
				if (waiter) {
					this.pending.delete(msg.id);
					waiter.resolve(msg);
				}
			} else if (msg && msg.type) {
				this.events.push(msg);
				for (const waiter of [...this.eventWaiters]) {
					if (!waiter.pred(msg)) continue;
					clearTimeout(waiter.timer);
					this.eventWaiters.splice(this.eventWaiters.indexOf(waiter), 1);
					waiter.resolve(msg);
				}
			}
		}
	}

	/** Send a command; resolves with the correlated response line. */
	send(cmd, { timeoutMs = 45000 } = {}) {
		const id = cmd.id ?? `req-${++this.seq}`;
		const payload = { ...cmd, id };
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`RPC timeout after ${timeoutMs}ms for ${cmd.type} (stderr: ${this.stderr.slice(-400)})`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (m) => {
					clearTimeout(timer);
					resolve(m);
				},
			});
			this.child.stdin.write(`${JSON.stringify(payload)}\n`);
		});
	}

	/** Wait until an event matching `pred` is observed (or already was). */
	waitForEvent(pred, { timeoutMs = 60000 } = {}) {
		const found = this.events.find(pred);
		if (found) return Promise.resolve(found);
		return new Promise((resolve, reject) => {
			const waiter = {
				pred,
				resolve,
				timer: setTimeout(() => {
					this.eventWaiters.splice(this.eventWaiters.indexOf(waiter), 1);
					reject(new Error(`event wait timeout after ${timeoutMs}ms`));
				}, timeoutMs),
			};
			this.eventWaiters.push(waiter);
		});
	}

	/** End stdin so the RPC process exits cleanly. */
	close() {
		try {
			this.child.stdin.end();
		} catch {}
	}
}
