import type { OperationRow } from "./permission-operation-fs.ts";

export const processOperations: readonly OperationRow[] = [
	{ api: "child_process.spawnSync", code: "const result=cp.spawnSync(p).status;", shape: "number" },
	{ api: "child_process.execSync", code: "const result=cp.execSync(JSON.stringify(p));", shape: "buffer" },
	{ api: "child_process.execFileSync", code: "const result=cp.execFileSync(p);", shape: "buffer" },
	{
		api: "child_process.spawn",
		code: "const c=cp.spawn(p);const result=await new Promise((r,j)=>{c.on('error',j);c.on('close',r)});",
		shape: "number",
	},
	{
		api: "child_process.exec",
		code: "const result=await new Promise((r,j)=>cp.exec(JSON.stringify(p),(e,o)=>e?j(e):r(o)));",
		shape: "string",
	},
	{
		api: "child_process.execFile",
		code: "const result=await new Promise((r,j)=>cp.execFile(p,(e,o)=>e?j(e):r(o)));",
		shape: "string",
	},
	{
		api: "child_process.fork",
		seed: "module" as const,
		code: "const c=cp.fork(p,[],{stdio:'pipe'});const result=await new Promise((r,j)=>{c.on('error',j);c.on('close',r)});",
		shape: "number",
	},
	{ api: "Bun.spawn", code: "const c=Bun.spawn([p]);const result=await c.exited;", shape: "number" },
	{ api: "Bun.spawn(cmd)", code: "const c=Bun.spawn({cmd:[p]});const result=await c.exited;", shape: "number" },
	{ api: "Bun.spawnSync", code: "const result=Bun.spawnSync([p]).exitCode;", shape: "number" },
	{ api: "Bun.spawnSync(cmd)", code: "const result=Bun.spawnSync({cmd:[p]}).exitCode;", shape: "number" },
	{ api: "Bun.$", code: `const result=await Bun.$\`\${p}\`.text();`, shape: "string" },
	{ api: "Bun.$(array)", code: `const result=await Bun.$\`\${[p]}\`.text();`, shape: "string" },
	{ api: "Bun.$(raw)", code: `const result=await Bun.$\`\${{raw:JSON.stringify(p)}}\`.text();`, shape: "string" },
].map((row): OperationRow => ({ seed: "executable", ...row, tool: "bash" }));
