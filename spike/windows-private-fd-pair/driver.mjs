// S0 driver: plays the desktop backend (H1). Creates the fd 5/6 pipe pair with Node's spawn, runs the Bun
// chain H2 (hop) -> H3 (hop) -> H4 (engine) from probe.exe, and turns the probe's `S0 <json>` lines into a
// pass/fail verdict per design rev 2.2 S0 item. Item 6 runs a Node child for fd 9/10. Output: s0-results.json.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const PROBE = process.argv[2];
const results = {};
const record = (item, ok, detail) => {
	results[item] = { ok, ...detail };
	console.log(`${ok ? "PASS" : "FAIL"} ${item} ${JSON.stringify(detail)}`);
};
const deadline = (ms, label) =>
	new Promise((_, reject) => setTimeout(() => reject(new Error(`deadline ${label}`)), ms));

function launch(args, extraSlots = 2) {
	const stdio = ["ignore", "pipe", "inherit", "ignore", "ignore", ...Array(extraSlots).fill("pipe")];
	const child = spawn(PROBE, args, { stdio });
	const lines = [];
	const waiters = [];
	createInterface({ input: child.stdout }).on("line", (line) => {
		if (!line.startsWith("S0 ")) return;
		const msg = JSON.parse(line.slice(3));
		lines.push(msg);
		for (const w of [...waiters]) if (w.match(msg)) {
			waiters.splice(waiters.indexOf(w), 1);
			w.resolve(msg);
		}
	});
	const next = (match) => {
		const hit = lines.find(match);
		return hit ? Promise.resolve(hit) : new Promise((resolve) => waiters.push({ match, resolve }));
	};
	return { child, lines, next, r: child.stdio[5], w: child.stdio[6] };
}

async function scenarioMain(clear) {
	const tag = clear ? "clear" : "noclear";
	const run = launch(["hop", "2", clear ? "1" : "0", "main"]);
	let fromW = "";
	let wEnded = false;
	const sawW = (needle) =>
		new Promise((resolve) => {
			const check = () => fromW.includes(needle) && resolve(true);
			run.w.on("data", (d) => {
				fromW += d.toString();
				check();
			});
			check();
		});
	run.w.on("end", () => {
		wEnded = true;
	});
	const exited = new Promise((resolve) => run.child.once("exit", resolve));
	try {
		const engine = await Promise.race([run.next((m) => m.item === "engine-receipt"), deadline(20_000, "engine receipt")]);
		const hops = run.lines.filter((m) => m.item === "hop-receipt");
		const types = engine.received.map((d) => d.type);
		record(`item2-fstat-type[${tag}]`, types.every((t) => t === "fifo"), { types, hopTypes: hops.map((h) => h.before.map((d) => d.type)) });
		record(`item3-forwarding[${tag}]`, engine.received.every((d) => d.fileType === 3), {
			note: clear
				? "hops cleared HANDLE_FLAG_INHERIT BEFORE forwarding; a working pair at the engine means numeric forwarding passes its own inheritable duplicate (no re-mark needed)"
				: "hops left the flag as received",
			engineReceived: engine.received,
			hopReceipts: hops.map((h) => ({ depth: h.depth, before: h.before, after: h.after })),
		});
		await Promise.race([Promise.all([sawW("via-fs\n"), sawW("via-handle\n")]), deadline(10_000, "item1 bytes")]);
		record(`item1-handle-mapping[${tag}]`, true, { note: "bytes written via fs.writeSync(6) and via WriteFile(_get_osfhandle(6)) both reached the peer" });
		await Promise.race([sawW("while-read-pending\n"), deadline(10_000, "item4 write while read parked")]);
		record(`item4-concurrent-read-write[${tag}]`, true, { note: "engine wrote on w while its fs read on r was parked and nothing had been written to r" });
		const fs8 = await Promise.race([run.next((m) => m.item === "item8-async-fs-while-parked"), deadline(15_000, "item8")]);
		const sync8 = run.lines.find((m) => m.item === "item8-fs-while-parked");
		record(`item8-fs-pool-not-starved[${tag}]`, true, { sync: sync8, async: fs8 });
		await Promise.race([sawW("ready-for-go\n"), deadline(10_000, "ready")]);
		run.r.write("go\n");
		await Promise.race([new Promise((resolve) => (wEnded ? resolve() : run.w.once("end", resolve))), deadline(10_000, "item7 EOF on w")]);
		run.r.write("eof-seen\n");
		await Promise.race([run.next((m) => m.item === "item7-peer-saw-eof"), deadline(10_000, "item7 ack")]);
		record(`item7-closeSync-closes-handle[${tag}]`, true, { note: "engine closeSync(6) produced EOF at the peer while the engine was still alive" });
	} catch (error) {
		record(`main[${tag}]`, false, { error: String(error), lines: run.lines });
		run.child.kill();
	}
	await Promise.race([exited, deadline(15_000, "exit")]).catch(() => run.child.kill());
}

async function scenarioLeak(clear) {
	const tag = clear ? "clear" : "noclear-control";
	const run = launch(["hop", "2", clear ? "1" : "0", "leak"]);
	run.r.end();
	let ended = false;
	run.w.on("data", () => {});
	const eof = new Promise((resolve) => run.w.once("end", () => {
		ended = true;
		resolve();
	}));
	try {
		await Promise.race([run.next((m) => m.item === "item5-closed-w"), deadline(20_000, "closed w")]);
		const got = await Promise.race([eof.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5_000))]);
		const expected = clear;
		record(`item5-no-leak-to-grandchild[${tag}]`, got === expected, {
			eofWhileGrandchildAlive: got,
			expected: expected ? "EOF (grandchild did not inherit w)" : "NO EOF (control: grandchild inherited w, proving the leak exists without clearing)",
			engine: run.lines.find((m) => m.item === "engine-receipt"),
		});
	} catch (error) {
		record(`item5[${tag}]`, false, { error: String(error), ended, lines: run.lines });
	}
	run.child.kill();
}

async function scenarioNode() {
	const stdio = ["ignore", "pipe", "inherit", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", "pipe", "pipe"];
	const child = spawn(process.execPath, [fileURLToPath(new URL("./node-child.mjs", import.meta.url)), PROBE], { stdio });
	const to9 = child.stdio[9];
	const from10 = child.stdio[10];
	let got = "";
	from10.on("data", (d) => {
		got += d.toString();
		if (got.includes("hello\n") && !got.includes("#")) {
			got += "#";
			to9.write("ping\n");
		}
	});
	const lines = [];
	createInterface({ input: child.stdout }).on("line", (l) => l.startsWith("S0 ") && lines.push(JSON.parse(l.slice(3))));
	try {
		await Promise.race([new Promise((resolve) => from10.once("end", resolve)), deadline(20_000, "item6 EOF on fd 10")]);
		const adopt = lines.find((m) => m.item === "item6-adopt");
		record("item6-node-sea-adoption-and-startup-clear", got.includes("pong\n"), {
			adoption: adopt,
			note: "fd 10 reached EOF while the Node child's grandchild was alive, so the grandchild did not inherit fd 10 (startup uv_disable_stdio_inheritance)",
			lines,
		});
	} catch (error) {
		record("item6-node-sea-adoption-and-startup-clear", false, { error: String(error), got, lines });
	}
	child.kill();
}

await scenarioMain(true);
await scenarioMain(false);
await scenarioLeak(true);
await scenarioLeak(false);
await scenarioNode();
results.environment = { node: process.version, platform: process.platform, arch: process.arch };
writeFileSync("s0-results.json", JSON.stringify(results, null, 2));
const failed = Object.entries(results).filter(([k, v]) => k !== "environment" && !v.ok).map(([k]) => k);
console.log(failed.length ? `S0 FAILED ITEMS: ${failed.join(", ")}` : "S0 ALL ITEMS PASSED");
process.exit(failed.length ? 1 : 0);
