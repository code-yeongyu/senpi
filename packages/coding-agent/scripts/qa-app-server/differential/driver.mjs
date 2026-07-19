import { request as httpRequest } from "node:http";
import WebSocket from "ws";

export class DriverError extends Error {
	name = "DriverError";
}

export class DriverClosedError extends Error {
	name = "DriverClosedError";
}

export class RawWebSocketDriver {
	#records = [];
	#waiters = new Set();
	#closed = false;

	constructor(socket, target) {
		this.socket = socket;
		this.target = target;
		socket.on("message", (data, isBinary) => this.#receive(data, isBinary));
		socket.on("close", () => this.#closeWaiters(new DriverClosedError(`${target} websocket closed.`)));
		socket.on("error", (error) => this.#closeWaiters(new DriverClosedError(`${target} websocket failed.`, { cause: error })));
	}

	get transcript() {
		return this.#records.map((record) => ({ ...record }));
	}

	mark() {
		return this.#records.length;
	}

	async sendRaw(bytes) {
		if (this.#closed || this.socket.readyState !== WebSocket.OPEN) {
			throw new DriverClosedError(`${this.target} websocket is not open.`);
		}
		this.#record("client->server", parseFrame(bytes));
		await new Promise((resolve, reject) => this.socket.send(bytes, (error) => (error ? reject(error) : resolve())));
	}

	async sendBinary(bytes) {
		if (this.#closed || this.socket.readyState !== WebSocket.OPEN) {
			throw new DriverClosedError(`${this.target} websocket is not open.`);
		}
		this.#record("client->server", { binaryFrameBase64: Buffer.from(bytes).toString("base64") });
		await new Promise((resolve, reject) => this.socket.send(bytes, { binary: true }, (error) => (error ? reject(error) : resolve())));
	}

	async requestRaw(bytes, id, timeoutMs = 15000) {
		const from = this.mark();
		await this.sendRaw(bytes);
		const record = await this.waitForInbound(
			(frame) => isObject(frame) && Object.hasOwn(frame, "id") && frame.id === id,
			from,
			timeoutMs,
		);
		return record.frame;
	}

	waitForInbound(predicate, from = 0, timeoutMs = 15000) {
		const existing = this.#records.slice(from).find((record) => record.direction === "server->client" && predicate(record.frame));
		if (existing !== undefined) return Promise.resolve(existing);
		if (this.#closed) return Promise.reject(new DriverClosedError(`${this.target} websocket closed before the frame arrived.`));
		return new Promise((resolve, reject) => {
			const waiter = { predicate, from, resolve, reject, timer: undefined };
			waiter.timer = setTimeout(() => {
				this.#waiters.delete(waiter);
				reject(new DriverError(`Timed out waiting for ${this.target} websocket frame.`));
			}, timeoutMs);
			this.#waiters.add(waiter);
		});
	}

	async close() {
		if (this.#closed || this.socket.readyState === WebSocket.CLOSED) return;
		const closed = new Promise((resolve) => this.socket.once("close", resolve));
		this.socket.close(1000, "scenario-complete");
		const timer = setTimeout(() => this.socket.terminate(), 2000);
		await closed;
		clearTimeout(timer);
	}

	#receive(data, isBinary) {
		const frame = isBinary ? { harnessError: "binary-websocket-frame" } : parseFrame(data.toString("utf8"));
		const record = this.#record("server->client", frame);
		for (const waiter of [...this.#waiters]) {
			if (record.seq <= waiter.from || !waiter.predicate(frame)) continue;
			clearTimeout(waiter.timer);
			this.#waiters.delete(waiter);
			waiter.resolve(record);
		}
	}

	#record(direction, frame) {
		const record = { seq: this.#records.length + 1, direction, target: this.target, frame };
		this.#records.push(record);
		return record;
	}

	#closeWaiters(error) {
		if (this.#closed) return;
		this.#closed = true;
		for (const waiter of this.#waiters) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		this.#waiters.clear();
	}
}

export async function connectDriver({ url, token, target, timeoutMs = 15000 }) {
	const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
	await waitForSocketOpen(socket, target, timeoutMs);
	return new RawWebSocketDriver(socket, target);
}

export function expectWebSocketRejected({ url, token, expectedStatus = 401, timeoutMs = 15000 }) {
	return new Promise((resolve, reject) => {
		const options = token === undefined ? undefined : { headers: { Authorization: `Bearer ${token}` } };
		const socket = new WebSocket(url, options);
		let settled = false;
		const timer = setTimeout(() => finish(new DriverError(`Timed out waiting for websocket rejection from ${url}.`)), timeoutMs);
		const finish = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.terminate();
			error === undefined ? resolve() : reject(error);
		};
		socket.once("unexpected-response", (_request, response) => {
			response.resume();
			finish(response.statusCode === expectedStatus ? undefined : new DriverError(`Expected HTTP ${expectedStatus}, received ${response.statusCode}.`));
		});
		socket.once("open", () => finish(new DriverError(`Websocket unexpectedly accepted a rejected token at ${url}.`)));
		socket.once("error", (error) => {
			if (!settled) finish(new DriverError(`Websocket rejection failed before an HTTP response at ${url}.`, { cause: error }));
		});
	});
}

export function httpStatus({ port, path, timeoutMs = 10000, signal }) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted === true) {
			reject(new DriverError("HTTP status request was aborted before it started."));
			return;
		}
		const request = httpRequest({ host: "127.0.0.1", port, path, method: "GET" });
		const timer = setTimeout(() => request.destroy(new DriverError(`Timed out reading http://127.0.0.1:${port}${path}.`)), timeoutMs);
		const onAbort = () => request.destroy(new DriverError("HTTP status request was aborted."));
		signal?.addEventListener("abort", onAbort, { once: true });
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		request.once("response", (response) => {
			cleanup();
			response.resume();
			resolve(response.statusCode ?? 0);
		});
		request.once("error", (error) => {
			cleanup();
			reject(error);
		});
		request.end();
	});
}

function waitForSocketOpen(socket, target, timeoutMs) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			socket.terminate();
			reject(new DriverError(`Timed out opening ${target} websocket.`));
		}, timeoutMs);
		const onOpen = () => {
			clearTimeout(timer);
			socket.off("error", onError);
			resolve();
		};
		const onError = (error) => {
			clearTimeout(timer);
			socket.off("open", onOpen);
			reject(new DriverError(`Failed to open ${target} websocket.`, { cause: error }));
		};
		socket.once("open", onOpen);
		socket.once("error", onError);
	});
}

function parseFrame(bytes) {
	try {
		return JSON.parse(bytes);
	} catch (error) {
		if (error instanceof SyntaxError) return bytes;
		throw error;
	}
}

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
