// E25 fixture extension (plan X13 through the real CLI): a tool whose body appends its tool call id to `ledger.txt` in
// the work dir as its first act, then stays in flight on a fake-server barrier (`GET $EQ_BARRIER_ORIGIN/__barrier/<name>`),
// then writes `out/<toolCallId>.txt`. The ledger is the X13 witness that no call runs again on resume: a re-run appends
// its id a second time (O5 tree), and its own start event shows in O5's calls. Loaded unmodified by path.
//
// - eq_ledger {barrier}: parallel; append the id, hold on <barrier>, write the out file.
//
// The append is synchronous: parallel bodies start in call order, but two `fs.promises.appendFile` calls run on separate
// threadpool threads and land in either order, which made ledger.txt flip between runs.
import { appendFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";

async function hold(barrier, signal) {
	const response = await fetch(`${process.env.EQ_BARRIER_ORIGIN}/__barrier/${encodeURIComponent(barrier)}`, {
		signal,
	});
	await response.text();
}

export default function ledgerTools(pi) {
	pi.registerTool({
		name: "eq_ledger",
		label: "EQ ledger",
		description:
			"EQ fixture: record this call in ledger.txt, wait for barrier <barrier>, then write out/<call id>.txt.",
		parameters: Type.Object({ barrier: Type.String() }),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			appendFileSync(resolve(ctx.cwd, "ledger.txt"), `${toolCallId}\n`);
			await hold(params.barrier, signal);
			await mkdir(resolve(ctx.cwd, "out"), { recursive: true });
			await writeFile(resolve(ctx.cwd, "out", `${toolCallId}.txt`), `${toolCallId}\n`);
			return { content: [{ type: "text", text: `eq_ledger ${toolCallId} done` }], details: {} };
		},
	});
}
