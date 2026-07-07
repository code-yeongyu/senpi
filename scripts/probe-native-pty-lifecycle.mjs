#!/usr/bin/env node
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const nativePathArg = process.argv[2];
if (!nativePathArg) {
	console.error("usage: probe-native-pty-lifecycle.mjs <native.node>");
	process.exit(2);
}

const nativePath = resolve(nativePathArg);
const require = createRequire(import.meta.url);
const native = require(nativePath);
const chunks = [];
const createSession = native.startPtySession ?? native.createPtySession;
if (typeof createSession !== "function") {
	throw new Error("native binding missing startPtySession/createPtySession factory");
}

const session = createSession(
	{
		command: process.platform === "win32" ? "cmd.exe" : "cat",
		args: process.platform === "win32" ? ["/d", "/q"] : [],
		cols: 80,
		rows: 24,
		timeoutMs: 5000,
	},
	(chunk) => {
		chunks.push(Buffer.from(chunk));
	},
);

for (const method of ["write", "resize", "kill", "waitExit"]) {
	if (typeof session[method] !== "function") {
		throw new Error(`native PtySession missing ${method}()`);
	}
}

session.resize(100, 30);
session.write(process.platform === "win32" ? "echo senpi-native-probe\r\n" : "senpi-native-probe\n");

const deadline = Date.now() + 3000;
while (Date.now() < deadline && !Buffer.concat(chunks).toString("utf8").includes("senpi-native-probe")) {
	await delay(25);
}
const output = Buffer.concat(chunks).toString("utf8");
if (!output.includes("senpi-native-probe")) {
	throw new Error("native PtySession did not stream written data");
}

session.kill();
const exit = await session.waitExit();
if (!exit || typeof exit !== "object") throw new Error("native PtySession waitExit returned no exit object");
if (exit.cancelled !== true) throw new Error(`native PtySession exit was not cancelled: ${JSON.stringify(exit)}`);

process.stdout.write(
	JSON.stringify(
		{
			nativePath,
			exports: Object.keys(native).sort(),
			methods: ["write", "resize", "kill", "waitExit"],
			output,
			exit,
		},
		null,
		2,
	),
);
process.stdout.write("\n");
