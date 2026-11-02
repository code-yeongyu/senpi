// Test-only Node preload. No per-poll I/O: counters stay in memory until requested.
if (require("node:worker_threads").isMainThread) {
const http = require("node:http");
const net = require("node:net");
const interval = globalThis.setInterval;
const clear = globalThis.clearInterval;
const loops = [];
const timers = new Map();
const waiters = new Set();
const events = [];
let closed = 0;

function snapshot() {
	return { pid: process.pid, closed, loops: loops.map((loop) => ({ ...loop })), events: [...events] };
}
function matches(url) {
	const count = Number(url.searchParams.get("count") ?? 0);
	switch (url.searchParams.get("wait")) {
		case "closed": return closed >= count;
		case "session_parked":
		case "session_resumed": return events.filter((event) => event.type === url.searchParams.get("wait")).length >= count;
		case "polling": {
			const active = loops.filter((loop) => loop.active);
			return active.length === 3 && active.every((loop) => loop.polls > Number(url.searchParams.get(`loop${loop.id}`) ?? 0));
		}
		default: return true;
	}
}
function notify() {
	for (const waiter of waiters) if (matches(waiter.url)) waiter.finish(200);
}
globalThis.__parkedSessionQa = {
	record(type, sessionId) { events.push({ type, sessionId }); notify(); },
};
globalThis.setInterval = function (callback, ms, ...args) {
	// A narrow stack match deliberately fails closed for minified/renamed artifacts.
	const stack = ms === 250 ? new Error().stack ?? "" : "";
	if (!/FileWatchLoop|monitor-file-watch\.[cm]?[jt]s/.test(stack)) return interval(callback, ms, ...args);
	const loop = { id: loops.length, polls: 0, active: true, stack };
	loops.push(loop);
	const timer = interval(function (...values) {
		try { return Reflect.apply(callback, this, values); }
		finally { loop.polls++; if (waiters.size) notify(); }
	}, ms, ...args);
	timers.set(timer, loop);
	return timer;
};
globalThis.clearInterval = function (timer) {
	const loop = timers.get(timer);
	if (loop) { loop.active = false; timers.delete(timer); }
	return clear(timer);
};
// Observe server-side socket closure, not merely RpcClient.stop()'s local destroy.
const emit = net.Server.prototype.emit;
net.Server.prototype.emit = function (event, ...args) {
	if (event === "connection" && this.address() === process.env.PARKED_QA_RPC_SOCKET) {
		args[0].once("close", () => { closed++; notify(); });
	}
	return Reflect.apply(emit, this, [event, ...args]);
};
const server = http.createServer((req, res) => {
	const url = new URL(req.url, "http://localhost");
	let timer;
	const waiter = {
		url,
		finish(status) {
			clearTimeout(timer);
			waiters.delete(waiter);
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(snapshot()));
		},
	};
	if (matches(url)) return waiter.finish(200);
	waiters.add(waiter);
	timer = setTimeout(() => waiter.finish(408), 30_000);
	res.once("close", () => { clearTimeout(timer); waiters.delete(waiter); });
});
server.on("error", (error) => { console.error(error); process.exitCode = 1; });
server.listen(process.env.PARKED_QA_OBSERVER_SOCKET, () => {
	server.unref();
	process.stderr.write("parked-qa-observer-ready\n");
});
}
