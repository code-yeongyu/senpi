# packages/protocol

`@earendil-works/pi-protocol` — transport-neutral CBOR wire protocol for remote pi sessions: TypeBox schemas, message codec, byte-stream framing. Consumed by `packages/server` and `packages/client`. Node `>=22.19.0`; only dependency is `typebox`.

## STRUCTURE

```text
src/index.ts        Root barrel; the package's only export
src/schemas.ts      All TypeBox wire schemas + derived types; PROTOCOL_VERSION
src/codec.ts        Validate/encode/parse messages; incremental decoders
src/framing.ts      4-byte big-endian length prefix; FrameDecoder/FrameError
src/cbor/           CBOR encoder/decoder/options with resource limits
test/               protocol.test.ts, framing.test.ts, cbor/cbor.test.ts (Vitest)
```

## INVARIANTS

- Transport-neutral: bytes in, bytes out. No socket/stream code here; callers own the transport. Incremental decoders must tolerate arbitrary fragmentation and coalescing.
- Wire format: u32 big-endian frame length + one definite-length CBOR item. First client message is always `hello` carrying `PROTOCOL_VERSION`.
- Every message parse goes through `codec.ts` TypeBox validation (strict objects, `additionalProperties: false`); never trust raw `decodeCbor` output as a message.
- Resource limits are load-bearing and configurable: frame <=16 MiB (`DEFAULT_MAX_FRAME_LENGTH`), CBOR <=16 MiB bytes / 1M containers / depth 64 (cap 512). Keep them enforced.
- `JsonValue` recursion uses `Type.Cyclic`; explicit `undefined` optional properties are omitted on wire.
- Progress events are transient UI hints; never reduce them into authoritative session/server state.

## WHERE TO LOOK

| Task | Path |
|---|---|
| Add/change a message or field | `src/schemas.ts` (+ `test/protocol.test.ts`) |
| Validation or encode/parse rules | `src/codec.ts` |
| Frame layout, decoder limits | `src/framing.ts` |
| CBOR internals / limits | `src/cbor/` |
| Wire contract prose | `README.md` |

## VALIDATION

- `bun run test` (Vitest `--run`) from this package; `bun run build` to typecheck against the build config.
- Root `bun run check` after changes.
- Schema/codec changes ripple to `packages/server` and `packages/client`; run their tests too.
