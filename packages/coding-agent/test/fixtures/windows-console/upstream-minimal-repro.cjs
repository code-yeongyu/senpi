// Minimal public repro for firebase-tools' Windows emulator launch (no senpi involved). Run it from a process with no
// console of its own (an IDE, a GUI app, or a service) on Windows: node upstream-minimal-repro.cjs <shape> <pid file>.
// "today" is _runBinary's options for a shell: true emulator; the other shapes are candidate fixes to measure.
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

const [shape, pidFile] = process.argv.slice(2);
const leaf = join(__dirname, "leaf.cjs");
const quoted = (value) => `"${value}"`;
const firebaseStdio = ["inherit", "pipe", "pipe"];
const SHAPES = {
	today: { shell: true, detached: true },
	"today-windowsHide": { shell: true, detached: true, windowsHide: true },
	"shell-not-detached-windowsHide": { shell: true, detached: false, windowsHide: true },
	"direct-detached": { shell: false, detached: true },
	"direct-detached-windowsHide": { shell: false, detached: true, windowsHide: true },
	"direct-not-detached-windowsHide": { shell: false, detached: false, windowsHide: true },
};
const options = SHAPES[shape];
if (!options) throw new Error(`unknown shape ${shape}`);
const child = options.shell
	? spawn(quoted(process.execPath), [quoted(leaf), quoted(pidFile)], { ...options, stdio: firebaseStdio })
	: spawn(process.execPath, [leaf, pidFile], { ...options, stdio: firebaseStdio });
child.unref();
child.stdout.resume();
child.stderr.resume();
setTimeout(() => {}, 30000);
