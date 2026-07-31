import { spawn } from "node:child_process";
import { join } from "node:path";
import { cliEntry, track, tsxEntry } from "./common.mjs";

export class TargetRpcClient {
	constructor({ env, cwd, targetRoot }) {
		const argv = [
			tsxEntry(targetRoot),
			"--tsconfig",
			join(targetRoot, "tsconfig.json"),
			cliEntry(targetRoot),
			"--mode",
			"rpc",
			"--no-context-files",
		];
		this.child = track(spawn(process.execPath, argv, { cwd, env, stdio: ["pipe", "pipe", "pipe"] }));
		this.pending = new Map();
		this.waiters = [];
		this.events = [];
		this.buffer = "";
		this.stderr = "";
		this.child.stdout.on("data", (chunk) => this.onData(chunk));
		this.child.stderr.on("data", (chunk) => {
			this.stderr += chunk.toString();
		});
	}

	onData(chunk) {
		this.buffer += chunk.toString();
		let newline;
		while ((newline = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (!line) continue;
			const message = JSON.parse(line);
			if (message.type === "response" && this.pending.has(message.id)) {
				this.pending.get(message.id)(message);
				this.pending.delete(message.id);
				continue;
			}
			const event = { at: Date.now(), message };
			this.events.push(event);
			for (const waiter of [...this.waiters]) {
				if (!waiter.predicate(event)) continue;
				this.waiters.splice(this.waiters.indexOf(waiter), 1);
				waiter.resolve(event);
			}
		}
	}

	waitFor(predicate, timeoutMs = 60_000) {
		return new Promise((resolveWait, reject) => {
			const timer = setTimeout(() => {
				this.waiters = this.waiters.filter((waiter) => waiter.resolve !== resolve);
				reject(new Error(`event timeout; stderr=${this.stderr.slice(-400)}`));
			}, timeoutMs);
			const resolve = (event) => {
				clearTimeout(timer);
				resolveWait(event);
			};
			this.waiters.push({ predicate, resolve });
		});
	}

	send(command, timeoutMs = 60_000) {
		const id = `req-${this.pending.size + 1}-${Date.now()}`;
		return new Promise((resolveSend, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`RPC timeout ${command.type}; stderr=${this.stderr.slice(-400)}`));
			}, timeoutMs);
			this.pending.set(id, (response) => {
				clearTimeout(timer);
				resolveSend(response);
			});
			this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		});
	}

	close() {
		return new Promise((resolveClose) => {
			if (this.child.exitCode !== null) return resolveClose();
			const timer = setTimeout(() => this.child.kill("SIGKILL"), 5_000);
			this.child.once("close", () => {
				clearTimeout(timer);
				resolveClose();
			});
			this.child.stdin.end();
		});
	}
}
