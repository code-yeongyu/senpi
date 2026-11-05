// Bun-only: reads an archive with Bun's tar reader, independent of the producer's writer.
const archive = Buffer.from(await Bun.stdin.text(), "base64");
const result = { files: {}, lastModified: {} };
for (const [path, file] of await new Bun.Archive(archive).files()) {
	result.files[path] = Buffer.from(await file.bytes()).toString("base64");
	result.lastModified[path] = file.lastModified;
}
console.log(JSON.stringify(result));
