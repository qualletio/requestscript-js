# requestscript-js

A Typescript implementation of RequestScript — the language, interpreter, and HTTP server, packaged as an npm library. The language is specified in [intro-guide.md](./intro-guide.md); this README documents how to use the package and the design decisions made where the guide left room.

## Using as a library

The root export is the language itself — no server, database, or Express involved:

```ts
import { interpret } from 'requestscript-js';

const result = await interpret(source, { resources, parameters });
console.log(result.returnValue);
```

Everything needed to build on the language is exported: `tokenize`, `parseScript`, the AST types, `Decimal`, the error classes, and the `Resource` interfaces.

The HTTP server lives behind the `requestscript-js/server` subpath:

```ts
import { createResourceResolver } from 'requestscript-js';
import { startServer, createApp, runMigrations } from 'requestscript-js/server';

// Batteries included: connects, migrates, and listens.
const running = await startServer({
  port: 3000,
  resourceResolver: createResourceResolver([]),
  middleware: [authMiddleware], // optional express middleware, e.g. auth
});
await running.close();

// Or embed the Express app with your own database handle (any drizzle
// Postgres driver works, e.g. PGlite in tests):
const app = createApp({ db, resourceResolver, middleware: [authMiddleware] });
```

Scripts resolve host resources through a `ResourceResolver`; build one from a fixed list with `createResourceResolver(resources)` or implement the interface for dynamic lookup. `middleware` is a list of standard express handlers installed ahead of every route, in order — a handler that ends the response (e.g. a `401`) stops the request, and errors passed to `next()` come back as the server's JSON error shape.

The bundled migrations ship with the package and are applied by `startServer`/`runMigrations` regardless of the working directory.

The package also installs a `requestscript-server` executable that starts the server using the environment variables below.

## Developing

```sh
pnpm install
docker compose up -d          # Postgres (set POSTGRES_PORT to override the host port)
pnpm dev                      # migrates the database, then serves on http://localhost:3000
pnpm test                     # full test suite (uses embedded PGlite, no Docker needed)
pnpm build                    # compiles to dist/ (also run automatically on pack/publish)
```

Configuration is via environment variables: `DATABASE_URL` (defaults to `postgres://requestscript:requestscript@localhost:5432/requestscript`) and `PORT` (defaults to `3000`). Migrations live in `./drizzle`, are generated with `pnpm db:generate`, and are applied automatically on server start (or manually with `pnpm db:migrate`).

## HTTP API

| Method & path | Body | Purpose |
| --- | --- | --- |
| `POST /run` | script text | Execute a `request` script once; responds `{ "returnValue": ... }` |
| `POST /contracts` | script text | Create a `contract` script (`201`); `409` if that version already exists |
| `POST /run/<path>/<Name>` | `{ "parameters": { ... } }` | Invoke the latest version of a saved contract (omit the body when parameterless) |
| `POST /run/<path>/<Name>@<n>` | `{ "parameters": { ... } }` | Invoke a specific version of a saved contract |
| `GET /contracts` | — | List every saved contract version and its parameters |
| `DELETE /contracts/<path>/<Name>` | — | Delete every version of a contract |
| `DELETE /contracts/<path>/<Name>@<n>` | — | Delete one version of a contract |

Errors are returned as `{ "error": { "type", "message" } }`: lex/parse, parameter, and malformed-version errors are `400`, an already-existing contract version is `409`, script runtime errors are `422`, unknown contracts/routes are `404`.

Contracts are created through the dedicated `POST /contracts` endpoint; posting a contract script to `/run` (or a request script to `/contracts`) is rejected with a hint.

Contracts are immutable and keyed by `(path, name, version)`. The version is declared in the contract source after the name — `contract path.to.MyContract@1.2.3(param1: string) { ... }` — as dot-separated numbers (`@2`, `@1.5`, `@1.2.3`, ...), defaulting to `1` when omitted. Saving a `(path, name, version)` that already exists is rejected with `409`; to change a contract, save the entire contract again under a new version. "Latest" is decided by comparing versions numerically segment by segment (`1.10` is newer than `1.9`).

## Language notes and decisions

Everything in the intro guide is implemented: request/contract declarations, comments, `var`/`const` with type inference and no redeclaration or type changes, all built-in types (`int32`, `int64`, `decimal`, `boolean`, `string`, `object`, `[]T` lists), string interpolation (nestable), object/list literals with trailing commas, dot and index access, `return`, `if`/`else if`/`else` with `&&`, `||`, `!`, and host resources with named-argument calls.

Decisions beyond the guide:

- **Contract versions.** A contract may declare its version with `@<version>` after the name (`contract a.b.C@1.2.3 { ... }`); the version is one or more dot-separated numbers — plain (`@2`), decimal (`@1.5`), semantic (`@1.2.3`), or deeper — and defaults to `1`. Versions are compared numerically per segment (missing segments count as 0), so `@1.10` is newer than `@1.9`; they are matched exactly as written, so `@1.0` and `@1` are distinct keys. Versions make contracts immutable: the server never overwrites a saved `(path, name, version)`, invoking or deleting by bare name targets the latest (respectively, every) version, and `Name@<version>` targets one version.
- **Operators.** Arithmetic (`+`, `-`, `*`, `/`), comparisons (`<`, `<=`, `>`, `>=`), and equality (`==`, `!=`, deep for objects/lists, by numeric value across number kinds) are supported, with conventional precedence and parentheses. `+` concatenates when either operand is a string. Conditions and logical operands must be booleans — there is no truthiness.
- **Strict numerics.** `int32` is range-checked; `int64` is backed by BigInt; `decimal` is exact fixed-point (BigInt units + scale), so `0.1 + 0.2 == 0.3` is `true`. Integer arithmetic that overflows its type raises a runtime error rather than wrapping; `/` between integers truncates (Kotlin-style); mixing integers and decimals produces decimals; decimal division rounds half-away-from-zero at scale `max(scales, 10)`. `decimal(p, s)` bounds the digits before/after the point at assignment. Small integer literals infer `int32`, larger ones `int64`.
- **JSON encoding.** `returnValue` encodes `int64`/`decimal` values as JSON numbers when they round-trip losslessly, otherwise as strings (e.g. `"9223372036854775807"`). Contract parameters likewise accept strings for high-precision `int64`/`decimal` values.
- **Mutability.** `var` supports reassignment (`x = ...`, `obj.prop = ...`, `list[0] = ...`) with the declared type enforced on variable assignment; `const` (and contract parameters) cannot be reassigned. `if` bodies are block scopes; shadowing an outer variable is an error, matching "cannot be redeclared".
- **Misc.** Missing object properties read as `null`; out-of-bounds list indexes are errors; `null` is a literal and is assignable to any type; a `return` with no value (or no return at all) yields `returnValue: null`; statements after a `return` are unreachable and skipped.
- **Resources** are bound with `const ref: path.to.ResourceName` and resolved eagerly. Arguments are type-checked against the declared parameter types and passed to `exec` as host values (`int32` → `number`, `int64` → `bigint`, `decimal` → `Decimal`, lists/objects → plain arrays/objects). `exec` may be async; `returnType: 'void'` yields `null`; other return values are validated against the declared return type. Supply server-wide resources through the `resourceResolver` option of `startServer`/`createApp`.

## Project layout

- `src/lang/` — the language: lexer, parser, AST, exact `Decimal`, type checking/coercion, tree-walking interpreter, resource interfaces. Re-exported as the package root (`requestscript-js`).
- `src/server/` — the `requestscript-js/server` subpath: express app (`app.ts`), `startServer` bootstrap (`start.ts`), contract storage via drizzle (`contracts.ts`), database schema and migrations (`db/`).
- `src/bin/requestscript-server.ts` — the `requestscript-server` executable.
- `test/` — vitest suites covering the lexer, parser, decimal arithmetic, every language feature, resources, contract parameters, and the HTTP server (against embedded PGlite with the real migrations).
