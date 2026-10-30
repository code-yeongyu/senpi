// A native handle for a denied path, obtained through the documented Bun.fetch read residual.
const minted = "await (await Bun.fetch('file://'+p)).blob()";

// One row per guarded sink line in the interposers. Each row must be refused as written, and must
// reopen when the single line carrying its `// sink:<name>` marker is deleted from the kernel copy.
export const sinkMutations = [
	{
		sink: "bun-file-mint",
		tool: "read",
		guarded: "stand-in",
		code: "if(Bun.file(p) instanceof Blob)throw new Error('native handle minted for a denied path');return 'guarded';",
	},
	{ sink: "bunfile-read", tool: "read", guarded: "refused", code: `return await (${minted}).text();` },
	{
		sink: "bunfile-write",
		tool: "write",
		guarded: "refused",
		code: `return String(await (${minted}).write('mutated'));`,
	},
	{
		sink: "bunfile-write-parts",
		tool: "read",
		guarded: "refused",
		code: `return String(await Bun.file(q).write([${minted}]));`,
	},
	{
		sink: "bunfile-writer",
		tool: "write",
		guarded: "refused",
		code: `const w=(${minted}).writer();w.write('mutated');return String(await w.end());`,
	},
	{
		sink: "bun-write-destination",
		tool: "write",
		guarded: "refused",
		code: `return String(await Bun.write(${minted},'mutated'));`,
	},
	{
		sink: "bun-write-parts",
		tool: "read",
		guarded: "refused",
		code: `return String(await Bun.write(q,[${minted}]));`,
	},
	{
		sink: "bun-serve",
		tool: "read",
		guarded: "refused",
		code: `const s=Bun.serve({port:0,routes:{'/f':${minted}}});try{return await (await fetch(new URL('/f',s.url))).text();}finally{s.stop(true);}`,
	},
	// A route value may be a per-method map. Bun reads the handle out of it, so the walk that reaches
	// nested values is its own sink line.
	{
		sink: "bun-serve-nested",
		tool: "read",
		guarded: "refused",
		code: `const s=Bun.serve({port:0,routes:{'/f':{GET:${minted}}}});try{return await (await fetch(new URL('/f',s.url))).text();}finally{s.stop(true);}`,
	},
	{
		sink: "spawn-stdin",
		tool: "read",
		guarded: "refused",
		code: `const c=Bun.spawn({cmd:['/bin/cat'],stdin:${minted},stdout:'pipe'});return await new Response(c.stdout).text();`,
	},
	{
		sink: "spawn-stdout",
		tool: "write",
		guarded: "refused",
		code: `return String(await Bun.spawn({cmd:['/bin/echo','mutated'],stdout:${minted}}).exited);`,
	},
	{
		sink: "spawn-stderr",
		tool: "write",
		guarded: "refused",
		code: `return String(await Bun.spawn({cmd:['/bin/echo','mutated'],stderr:${minted}}).exited);`,
	},
	// Bun gives an explicit stdio slot priority over the matching named option, and a slot at index 3
	// or above has no named option at all, so the slots carry their own decisions in both directions.
	{
		sink: "spawn-stdio-read",
		label: "spawn-stdio-read/slot0",
		tool: "read",
		guarded: "refused",
		code: `const c=Bun.spawn({cmd:['/bin/cat'],stdin:'ignore',stdio:[${minted},'pipe','ignore']});return await new Response(c.stdout).text();`,
	},
	{
		sink: "spawn-stdio-read",
		label: "spawn-stdio-read/slot3",
		tool: "read",
		guarded: "refused",
		code: `const c=Bun.spawn({cmd:['/bin/sh','-c','cat <&3'],stdio:['ignore','pipe','ignore',${minted}]});return await new Response(c.stdout).text();`,
	},
	{
		sink: "spawn-stdio-write",
		label: "spawn-stdio-write/slot1",
		tool: "write",
		guarded: "refused",
		code: `return String(await Bun.spawn({cmd:['/bin/echo','mutated'],stdout:'ignore',stdio:['ignore',${minted},'ignore']}).exited);`,
	},
	{
		sink: "spawn-stdio-write",
		label: "spawn-stdio-write/slot3",
		tool: "write",
		guarded: "refused",
		code: `return String(await Bun.spawn({cmd:['/bin/sh','-c','echo mutated >&3'],stdio:['ignore','ignore','ignore',${minted}]}).exited);`,
	},
	// A clone of an fd-backed handle has no readable intrinsic path and no grant, so it cannot be
	// decided at all. The file it points at is deliberately the allowed one: the refusal must come
	// from the handle being undecidable, not from the rule.
	{
		sink: "undecidable-read",
		tool: "read",
		guarded: "refused",
		code: "const fs=require('node:fs');const fd=fs.openSync(q,'r');try{return await structuredClone(Bun.file(fd)).text();}finally{fs.closeSync(fd);}",
	},
	// The stand-in handed out for a read-denied path answers metadata from the same file.
	{ sink: "standin-metadata", tool: "read", guarded: "refused", code: "return String(Bun.file(p).size);" },
	{
		sink: "bun-file-mint",
		tool: "read",
		guarded: "stand-in",
		code: "try{structuredClone(Bun.file(p));return 'copied';}catch(error){return error.name;}",
		expect: "DataCloneError",
	},
] as const;

export type SinkMutationRow = (typeof sinkMutations)[number];
