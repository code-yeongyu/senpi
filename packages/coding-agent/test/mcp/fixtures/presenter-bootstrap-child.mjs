import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { presenterBootstrapStream } from "../../../src/modes/rpc/mcp-presenter-bootstrap.ts";

const ownerInput = createReadStream(undefined, { fd: 3, autoClose: false });
const owner = createWriteStream(undefined, { fd: 3, autoClose: false });
const presenter = presenterBootstrapStream(4);
createInterface({ input: ownerInput }).on("line", (line) => {
	owner.write(`${JSON.stringify({ type: "owner", value: line })}\n`);
});
createInterface({ input: presenter }).on("line", (line) => {
	const record = JSON.parse(line);
	if (record.type === "enroll") {
		presenter.write(`${JSON.stringify({ type: "challenge", marker: record.marker })}\n`);
	} else if (record.type === "proof") {
		presenter.end(`${JSON.stringify({ type: "enrolled", marker: record.marker })}\n`);
	}
});
ownerInput.on("end", () => owner.end());
