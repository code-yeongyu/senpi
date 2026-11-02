import { existsSync, readFileSync } from "node:fs";

export function collectRpc(child) {
	const lines = [];
	const responses = new Map();
	let buffer = "";
	let sequence = 0;
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		buffer += chunk.toString();
		let newline;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			lines.push(message);
			const waiter = message.type === "response" ? responses.get(message.id) : undefined;
			if (waiter) {
				responses.delete(message.id);
				waiter(message);
			}
		}
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	const send = (command, timeoutMs = 120_000) => {
		const id = `req-${++sequence}`;
		return new Promise((resolveCommand, reject) => {
			const timer = setTimeout(() => reject(new Error(`timeout ${command.type}: ${stderr.slice(-300)}`)), timeoutMs);
			responses.set(id, (message) => {
				clearTimeout(timer);
				resolveCommand(message);
			});
			child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		});
	};
	const waitFor = (predicate, label, timeoutMs = 90_000) =>
		new Promise((resolveRecord, reject) => {
			const startedAt = Date.now();
			const check = () => {
				const record = lines.find(predicate);
				if (record) return resolveRecord(record);
				if (Date.now() - startedAt > timeoutMs) return reject(new Error(`timed out waiting for ${label}: ${stderr.slice(-300)}`));
				setTimeout(check, 50);
			};
			check();
		});
	return { lines, send, waitFor };
}

export function buildRpcReport(entry, scheduleEvents) {
	const data = entry.data;
	const schedule = scheduleEvents.at(-1)?.data;
	const basisDeltaMs = data.dueAtMs - data.delayMs - Date.parse(entry.timestamp);
	const assertions = {
		delayMsPositiveFinite: Number.isFinite(data.delayMs) && data.delayMs > 0,
		delayMsWithinCacheTtl: data.cache?.ttlSeconds === undefined || data.delayMs <= data.cache.ttlSeconds * 1000,
		dueAtMsFinite: Number.isFinite(data.dueAtMs),
		dueAtEqualsTimestampBasisPlusDelay: Number.isFinite(basisDeltaMs) && Math.abs(basisDeltaMs) <= 2000,
		iterationIsOne: data.iteration === 1,
		activeMonitorCountIsOne: data.activeMonitorCount === 1,
		scheduleEventMatchesEntry: schedule?.dueAtMs === data.dueAtMs && schedule?.delayMs === data.delayMs,
	};
	return { pass: Object.values(assertions).every(Boolean), assertions, entry, scheduleEvents, basisDeltaMs };
}

export function readJsonlFile(path) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

export function waitForClose(child) {
	return new Promise((resolveClose) => {
		const timer = setTimeout(resolveClose, 5000);
		child.once("close", () => {
			clearTimeout(timer);
			resolveClose();
		});
	});
}
