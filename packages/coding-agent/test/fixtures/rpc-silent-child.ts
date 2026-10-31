// A host child that listens on its internal socket, accepts, and never answers (senpi#3816 review): its pid goes to
// the file named by SENPI_TEST_SILENT_CHILD_PIDFILE before it listens, so a test can prove it was torn down.
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";

const listen = process.argv.at(-1);
if (!listen?.startsWith("unix://")) throw new Error("unix:// listen address required");
const pidFile = process.env.SENPI_TEST_SILENT_CHILD_PIDFILE;
if (pidFile) writeFileSync(pidFile, String(process.pid));
createServer((socket) => socket.resume()).listen(listen.slice("unix://".length));
