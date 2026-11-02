// Real extension source shared by the relocated CLI and compiled loader probe.
export const extensionSource = `
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { createEventBus, type ExtensionAPI } from "@code-yeongyu/senpi";
import { value, token } from "./helper.ts";
const moduleToken = {};
let factoryRuns = 0;
export default async function (pi: ExtensionAPI) {
  factoryRuns++;
  const name = "./helper.ts";
  const dynamic = await import(name);
  const result = {
    sentinel: "native-extension", value, dynamicIdentity: token === dynamic.token,
    typeboxKind: Type.String().type, tuiText: new Text("probe", 0, 0).render(5)[0],
    url: import.meta.url, path: import.meta.path,
  };
  pi.events.emit("extension-probe-identity", { Type, Text, createEventBus, moduleToken, factoryRuns, ...result });
  pi.rpc.handle("extension-probe", async () => {
    // The live runtime must retain its graph after the factory has returned.
    Bun.gc(true);
    const late = await import(name);
    return { ...result, dynamicIdentity: token === late.token };
  });
}
`;

export const compiledLoaderProbeSource = `
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { z } from "zod";
import { createEventBus } from "../packages/coding-agent/src/core/event-bus.ts";
import { loadExtensions, loadExtensionsCached } from "../packages/coding-agent/src/core/extensions/loader.ts";
const [entry] = process.argv.slice(2);
assert(entry);
const root = dirname(entry);
const bus = createEventBus();
const schema = z.object({
  Type: z.unknown(), Text: z.unknown(), createEventBus: z.unknown(), moduleToken: z.unknown(),
  factoryRuns: z.number(), value: z.number(), dynamicIdentity: z.boolean(),
});
const observed: z.infer<typeof schema>[] = [];
bus.on("extension-probe-identity", (value) => {
  const record = schema.parse(value);
  assert.equal(record.Type, Type, "host-identity-mismatch:typebox");
  assert.equal(record.Text, Text, "host-identity-mismatch:tui");
  assert.equal(record.createEventBus, createEventBus, "host-identity-mismatch:senpi");
  assert.equal(record.dynamicIdentity, true);
  observed.push(record);
});
const load = async (cached: boolean, cwd: string) => {
  const result = await (cached ? loadExtensionsCached : loadExtensions)([entry], cwd, bus);
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
};
await load(false, root);
await load(false, root);
assert.equal(observed[0].moduleToken, observed[1].moduleToken, "unchanged source must reuse one module generation");
assert.deepEqual(observed.splice(0).map(record => record.factoryRuns), [1, 2]);
const otherCwd = join(root, "other-cwd");
mkdirSync(otherCwd, { recursive: true });
await load(true, otherCwd);
await load(true, root);
assert.equal(observed[0].moduleToken, observed[1].moduleToken, "cwd must not fork the module generation");
const tokenBeforeEdit = observed[1].moduleToken;
assert.deepEqual(observed.splice(0).map(record => record.factoryRuns), [3, 4]);
writeFileSync(join(root, "helper.ts"), "export const value: number = 42;\\nexport const token = {};\\n");
await load(true, root);
assert.notEqual(observed[0].moduleToken, tokenBeforeEdit, "an edited source must be recompiled");
assert.equal(observed[0].factoryRuns, 1, "a recompiled generation starts a fresh module scope");
assert.equal(observed[0].value, 42);
console.log(JSON.stringify({ reloadedHelper: observed[0].value }));
`;
