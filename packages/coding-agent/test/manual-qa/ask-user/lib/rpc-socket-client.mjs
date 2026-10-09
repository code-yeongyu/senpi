#!/usr/bin/env node
/** Line-delimited JSON RPC client over a unix socket for the ask-user probe. */

import { createConnection } from "node:net";

export class SocketRpcClient {
	constructor(socket, label, observe) {
		this.socket = socket;
		this.label = label;
		this.observe = observe;
		this.messages = [];
		this.waiters = new Set();
		this.buffer = "";
		this.closed = false;
		socket.on("data", (chunk) => this.read(chunk.toString("utf8")));
		socket.on("error", () => this.close());
	}

	static async connect(socketPath, label, observe = () => {}) {
		const socket = createConnection(socketPath);
		await withTimeout(
			new Promise((resolve, reject) => {
				socket.once("connect", resolve);
				socket.once("error", reject);
			}),
			15_000,
			`${label} connect`,
		);
		return new SocketRpcClient(socket, label, observe);
	}

	mark() {
		return this.messages.length;
	}

	count(fromIndex, predicate) {
		return this.messages.slice(fromIndex).filter(predicate).length;
	}

	find(fromIndex, predicate) {
		return this.messages.slice(fromIndex).find(predicate);
	}

	write(value) {
		const line = `${JSON.stringify(value)}\n`;
		this.observe({ direction: "out", label: this.label, line: line.trimEnd() });
		this.socket.write(line);
	}

	async request(command, timeoutMs = 20_000) {
		const id = `${this.label}-${this.mark() + 1}`;
		const mark = this.mark();
		this.write({ id, ...command });
		const response = await this.waitFor(
			(message) => message.type === "response" && message.id === id,
			mark,
			timeoutMs,
		);
		if (!response.success) throw new Error(`${command.type} failed: ${JSON.stringify(response.error)}`);
		return response;
	}

	waitFor(predicate, fromIndex = 0, timeoutMs = 20_000) {
		const existing = this.find(fromIndex, predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const waiter = { predicate, fromIndex, resolve, reject, timer: undefined };
			waiter.timer = setTimeout(() => {
				this.waiters.delete(waiter);
				reject(new Error(`${this.label}: timed out after ${timeoutMs}ms waiting for an RPC record`));
			}, timeoutMs);
			this.waiters.add(waiter);
		});
	}

	/** Wait for `expected` matching records, then hold `holdMs` to prove no more arrive. */
	async waitForStable(predicate, fromIndex, expected, holdMs, timeoutMs = 20_000) {
		if (expected > 0) await this.waitFor(predicate, fromIndex, timeoutMs);
		await delay(holdMs);
		const seen = this.count(fromIndex, predicate);
		if (seen !== expected) {
			throw new Error(`${this.label}: expected exactly ${expected} matching records, saw ${seen}`);
		}
		return this.find(fromIndex, predicate);
	}

	close() {
		if (this.closed) return;
		this.closed = true;
		for (const waiter of [...this.waiters]) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error(`${this.label}: socket closed`));
		}
		this.waiters.clear();
		this.socket.destroy();
	}

	read(text) {
		this.buffer += text;
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline === -1) return;
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (!line) continue;
			const message = JSON.parse(line);
			const index = this.messages.length;
			this.messages.push(message);
			this.observe({ direction: "in", label: this.label, line });
			for (const waiter of [...this.waiters]) {
				if (index < waiter.fromIndex || !waiter.predicate(message)) continue;
				clearTimeout(waiter.timer);
				this.waiters.delete(waiter);
				waiter.resolve(message);
			}
		}
	}
}

export function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function withTimeout(promise, timeoutMs, label) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

export function messageText(message) {
	if (!message || typeof message !== "object") return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
}
