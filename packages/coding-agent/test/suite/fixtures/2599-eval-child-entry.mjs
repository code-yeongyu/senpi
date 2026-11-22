import { createServer } from "node:net";

const receipt = {
	kind: "target-entry",
	execArgv: process.execArgv,
	argv: process.argv.slice(2),
};
const send = () => process.send(receipt, () => process.disconnect());

if (process.env.SENPI_ARGV_REPRO_CASE === "daemon") {
	const listen = process.argv[process.argv.indexOf("--listen") + 1];
	const server = createServer();
	server.listen(listen.slice("unix://".length), () => process.send(receipt));
	process.once("SIGTERM", () => server.close(() => process.disconnect()));
} else if (process.env.SENPI_ARGV_REPRO_CASE === "schedule") {
	process.stdin.once("end", send);
	process.stdin.resume();
} else {
	send();
}
