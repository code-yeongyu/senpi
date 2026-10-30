const encoded = JSON.parse(await Bun.stdin.text());
const files = Object.fromEntries(
	Object.entries(encoded).map(([path, base64]) => [path, Buffer.from(base64, "base64")]),
);
const bytes = await new Bun.Archive(files, { compress: "gzip" }).bytes();
const again = await new Bun.Archive(files, { compress: "gzip" }).bytes();
if (!Buffer.from(bytes).equals(Buffer.from(again))) throw new Error("archive bytes are not deterministic");
const recovered = await new Bun.Archive(bytes).files();
const result = {};
for (const [path, file] of recovered) result[path] = Buffer.from(await file.bytes()).toString("base64");
console.log(JSON.stringify(result));
