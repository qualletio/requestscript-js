# requestscript-js

A Typescript implementation of RequestScript — the language, interpreter, and HTTP server. The language is specified in [intro-guide.md](./intro-guide.md); this README documents how to run the project and the design decisions made where the guide left room.

## Getting started

```sh
pnpm install
docker compose up -d          # Postgres (set POSTGRES_PORT to override the host port)
pnpm dev                      # migrates the database, then serves on http://localhost:3000
pnpm test                     # full test suite (uses embedded PGlite, no Docker needed)
```

Configuration is via environment variables: `DATABASE_URL` (defaults to `postgres://requestscript:requestscript@localhost:5432/requestscript`) and `PORT` (defaults to `3000`). Migrations live in `./drizzle`, are generated with `pnpm db:generate`, and are applied automatically on server start (or manually with `pnpm db:migrate`).

## HTTP API

| Method & path | Body | Purpose |
| --- | --- | --- |
| `POST /run` | script text | Execute a `request` script once; responds `{ "returnValue": ... }` |
| `POST /contracts` | script text | Create (`201`) or update (`200`) a `contract` script |
| `POST /run/<path>/<Name>` | `{ "parameters": { ... } }` | Invoke a saved contract (omit the body when parameterless) |
| `GET /contracts` | — | List saved contracts and their parameters |
| `DELETE /contracts/<path>/<Name>` | — | Delete a contract |

Errors are returned as `{ "error": { "type", "message" } }`: lex/parse and parameter errors are `400`, script runtime errors are `422`, unknown contracts/routes are `404`.

Contracts are created through the dedicated `POST /contracts` endpoint; posting a contract script to `/run` (or a request script to `/contracts`) is rejected with a hint.

## Language notes and decisions

Everything in the intro guide is implemented: request/contract declarations, comments, `var`/`const` with type inference and no redeclaration or type changes, all built-in types (`int32`, `int64`, `decimal`, `boolean`, `string`, `object`, `[]T` lists), string interpolation (nestable), object/list literals with trailing commas, dot and index access, `return`, `if`/`else if`/`else` with `&&`, `||`, `!`, and host resources with named-argument calls.

Decisions beyond the guide:

- **Operators.** Arithmetic (`+`, `-`, `*`, `/`), comparisons (`<`, `<=`, `>`, `>=`), and equality (`==`, `!=`, deep for objects/lists, by numeric value across number kinds) are supported, with conventional precedence and parentheses. `+` concatenates when either operand is a string. Conditions and logical operands must be booleans — there is no truthiness.
- **Strict numerics.** `int32` is range-checked; `int64` is backed by BigInt; `decimal` is exact fixed-point (BigInt units + scale), so `0.1 + 0.2 == 0.3` is `true`. Integer arithmetic that overflows its type raises a runtime error rather than wrapping; `/` between integers truncates (Kotlin-style); mixing integers and decimals produces decimals; decimal division rounds half-away-from-zero at scale `max(scales, 10)`. `decimal(p, s)` bounds the digits before/after the point at assignment. Small integer literals infer `int32`, larger ones `int64`.
- **JSON encoding.** `returnValue` encodes `int64`/`decimal` values as JSON numbers when they round-trip losslessly, otherwise as strings (e.g. `"9223372036854775807"`). Contract parameters likewise accept strings for high-precision `int64`/`decimal` values.
- **Mutability.** `var` supports reassignment (`x = ...`, `obj.prop = ...`, `list[0] = ...`) with the declared type enforced on variable assignment; `const` (and contract parameters) cannot be reassigned. `if` bodies are block scopes; shadowing an outer variable is an error, matching "cannot be redeclared".
- **Misc.** Missing object properties read as `null`; out-of-bounds list indexes are errors; `null` is a literal and is assignable to any type; a `return` with no value (or no return at all) yields `returnValue: null`; statements after a `return` are unreachable and skipped.
- **Resources** are bound with `const ref: path.to.ResourceName` and resolved eagerly. Arguments are type-checked against the declared parameter types and passed to `exec` as host values (`int32` → `number`, `int64` → `bigint`, `decimal` → `Decimal`, lists/objects → plain arrays/objects). `exec` may be async; `returnType: 'void'` yields `null`; other return values are validated against the declared return type. Register server-wide resources in `src/server.ts`.

## Project layout

- `src/lang/` — the language: lexer, parser, AST, exact `Decimal`, type checking/coercion, tree-walking interpreter, resource interfaces. Usable standalone via `interpret(source, { resources, parameters })`.
- `src/server/` — express app (`app.ts`), contract storage via drizzle (`contracts.ts`), database schema and migrations (`db/`).
- `src/server.ts` — server entry point.
- `test/` — vitest suites covering the lexer, parser, decimal arithmetic, every language feature, resources, contract parameters, and the HTTP server (against embedded PGlite with the real migrations).
