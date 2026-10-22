/**
 * A `--import` preload for a test supervisor: the supervisor forwards its exec argv to the host child it spawns, and
 * the CHILD (the one process here carrying `--listen`) writes its own argv to the file named by
 * `RPC_HOST_ARGV_REPORT` before the CLI renames its process title, so a test can read the host args it received.
 */
import { writeFileSync } from "node:fs";

const report = process.env.RPC_HOST_ARGV_REPORT;
if (report && process.argv.includes("--listen")) writeFileSync(report, JSON.stringify(process.argv.slice(2)));
