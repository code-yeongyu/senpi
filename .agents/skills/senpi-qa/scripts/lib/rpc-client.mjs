// Shared JSON-lines RPC client over a spawned `--mode rpc` child, or over a running host's socket.
//
// Lives in lib/ so scenario scripts can drive RPC without importing rpc-drive.mjs,
// whose module body dispatches on argv the moment it is imported.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { repoRoot, resolveBun, spawnCli, track } from "./common.mjs";

const BRIDGE_FLAG = "--attach-bridge";

/**
 * Start a Bun child that connects to the host socket through the shipped transport
 * (rpc-client-socket.ts, including its authentication) and pipes JSON lines between its
 * stdio and the socket, so RpcClient speaks to an attached host exactly as to a spawned one.
 */
function spawnAttachBridge(socketPath, { env, cwd }) {
	const child = spawn(resolveBun().command, [fileURLToPath(import.meta.url), BRIDGE_FLAG, socketPath], {
		cwd: cwd || repoRoot(),
		env: env || process.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	track(child);
	return child;
}

async function runAttachBridge(socketPath) {
	// Bridge mode runs only under Bun, which loads the TypeScript transport directly; Node never reaches this import.
	const transport = pathToFileURL(join(repoRoot(), "packages", "coding-agent", "src", "modes", "rpc", "rpc-client-socket.ts"));
	const { connectRpcClientSocket } = await import(transport.href);
	const socket = await connectRpcClientSocket(socketPath, {});
	process.stdin.pipe(socket);
	socket.pipe(process.stdout);
	process.stdin.on("end", () => socket.end());
	socket.on("close", () => process.exit(0));
}

/**
 * Minimal JSON-lines RPC client. By default it spawns a `--mode rpc` CLI child whose session
 * is persisted under the env's session dir; with `attach` it drives the host listening on that socket.
 * Resolves send() promises by matching the response `id`; buffers events.
 */
export class RpcClient {
	constructor({ env, cwd, extraArgs = [], attach } = {}) {
		this.child =
			attach === undefined
				? spawnCli(["--mode", "rpc", "--no-context-files", ...extraArgs], { env, cwd })
				: spawnAttachBridge(attach, { env, cwd });
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
		// A child that exits (or a bridge that cannot connect) fails every pending request at once.
		this.child.on("close", (code, signal) => {
			for (const [id, waiter] of this.pending) {
				this.pending.delete(id);
				waiter.reject(new Error(`RPC child exited (${code ?? signal}) (stderr: ${this.stderr.slice(-400)})`));
			}
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
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
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

if (process.argv[2] === BRIDGE_FLAG && process.argv[1] === fileURLToPath(import.meta.url)) {
	runAttachBridge(process.argv[3]).catch((error) => {
		process.stderr.write(`attach bridge: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
}
