// Opens a store file when its parent writes a line to stdin: prints "start", then "ok <ms>" or "ERR <ms> <message>".
import { createInterface } from "node:readline";
import { openStoreFile } from "../src/sqlite-file.ts";

const [path] = process.argv.slice(2);
if (path === undefined) throw new Error("usage: <store path>");
await createInterface({ input: process.stdin })[Symbol.asyncIterator]().next();
console.log("start");
const started = Date.now();
try {
	openStoreFile(path).db.close();
	console.log(`ok ${Date.now() - started}`);
} catch (error) {
	console.log(`ERR ${Date.now() - started} ${error instanceof Error ? error.message : String(error)}`);
}
process.exit(0);
