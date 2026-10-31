// The npm/Firebase/Vitest shape behind omo#7691: a bash-tool command runs node, and that node launches leaf.cjs.
// argv: <shape> <pid file> <leaf pid file>. The shapes are the ways tools commonly launch a child on Windows.
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

const [shape, pidFile, leafPidFile] = process.argv.slice(2);
const leaf = join(__dirname, "leaf.cjs");
// firebase-java / firebase-shell mirror firebase-tools 15.33.0 lib/emulator/downloadableEmulators.js _runBinary:
// detached, stdin inherited, stdout/stderr piped, no windowsHide (the shell variant is its Pub/Sub launch).
const firebaseOptions = { detached: true, stdio: ["inherit", "pipe", "pipe"] };
const quoted = (value) => `"${value}"`;
const child =
	shape === "shell"
		? spawn(`${quoted(process.execPath)} ${quoted(leaf)} ${quoted(leafPidFile)}`, { stdio: "ignore", shell: true })
		: shape === "firebase-java"
			? spawn(process.execPath, [leaf, leafPidFile], firebaseOptions)
			: shape === "firebase-shell"
				? spawn(quoted(process.execPath), [quoted(leaf), quoted(leafPidFile)], { ...firebaseOptions, shell: true })
				: spawn(process.execPath, [leaf, leafPidFile], { stdio: "ignore", detached: shape === "detached" });
child.unref();
writeFileSync(pidFile, JSON.stringify({ grandparent: process.pid, grandchild: child.pid }));
setTimeout(() => {}, 30000);
