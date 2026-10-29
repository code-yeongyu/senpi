// Child process for the real-kill tests: opens a medium and SIGKILLs itself at one write point of a claim or commit.
import { createBunSqliteMedia } from "../../src/index.ts";

const [root = "", medium = "", op = "", at = "", index = "-1"] = process.argv.slice(2);
const store = await createBunSqliteMedia(root).open(medium, {
	onWritePoint: (point) => {
		if (point.op === op && point.at === at && (point.at !== "write" || point.index === Number(index))) {
			process.kill(process.pid, "SIGKILL");
		}
	},
});
if (op === "claim") {
	await store.claim(1, 2);
} else {
	const batch = [
		{ op: "append", id: "r2", kind: "entry", data: { id: "r2" } },
		{ op: "put", key: "doc", data: 2 },
		{ op: "append", id: "r3", kind: "entry", data: { id: "r3" } },
	] as const;
	await store.commit(1, batch, () => process.stdout.write("adopted\n"));
}
process.stdout.write("survived\n");
