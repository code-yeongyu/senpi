/**
 * The supervised host child (`rpc-supervised-child.ts`) that also writes its own cwd to the file
 * named first on argv, so a test can see which directory the supervisor spawned it in (senpi#3783).
 */
import { writeFileSync } from "node:fs";
import "./rpc-supervised-child.ts";

writeFileSync(process.argv[2] ?? "", process.cwd());
