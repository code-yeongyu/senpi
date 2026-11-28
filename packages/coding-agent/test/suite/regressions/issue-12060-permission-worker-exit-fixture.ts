import { join } from "node:path";
import { createPathIdentityResolver } from "../../../src/core/extensions/builtin/permission-system/path-identity-host.ts";

const resolver = createPathIdentityResolver();
const rule = await resolver.canonicalizeRule(join(process.cwd(), "x", "*"));
if (rule === undefined) throw new Error("Permission worker returned no rule");
process.stdout.write("RESOLVED\n");
// Do not close the process-wide resolver: an idle worker must allow natural exit.
