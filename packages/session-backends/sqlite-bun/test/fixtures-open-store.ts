// One process opening a store file once every go-file appears: prints "ok" or the error message.
import { existsSync } from "node:fs";
import { openStoreFile } from "../src/sqlite-file.ts";

const [path, go] = process.argv.slice(2);
if (path === undefined || go === undefined) throw new Error("usage: <store path> <go file>");
while (!existsSync(go)) await Bun.sleep(1);
try {
	openStoreFile(path).db.close();
	console.log("ok");
} catch (error) {
	console.log(`ERR ${error instanceof Error ? error.message : String(error)}`);
}
