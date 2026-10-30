# requestscript-js

A Typescript implementation of RequestScript — the language, interpreter, and HTTP server, packaged as an npm library. The language was originally specified in [intro-guide.md](./intro-guide.md); this README documents how to use the package and gives a full [language reference](#the-language), including the decisions made where the guide left room.

Join the [Discord](https://discord.gg/79agn5yPc) to coordinate your contributions with the Quallet team

## Using as a library

The root export is the language itself — no server, database, or Express involved:

```ts
import { interpret } from "requestscript-js";

const result = await interpret(source, { resources, parameters });
console.log(result.returnValue);
```

Everything needed to build on the language is exported: `tokenize`, `parseScript`, the AST types, `Decimal`, the error classes, the `Resource` interfaces, [token metering](#token-metering) (`TokenMeter`, `maxTokens`), and `compareVersions` for ordering contract versions.

The HTTP server lives behind the `requestscript-js/server` subpath:

```ts
import { createResourceResolver } from "requestscript-js";
import { startServer, createApp, runMigrations } from "requestscript-js/server";

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

| Method & path                         | Body                        | Purpose                                                                          |
| ------------------------------------- | --------------------------- | -------------------------------------------------------------------------------- |
| `POST /run`                           | script text                 | Execute a `request` script once; responds `{ "returnValue": ... }`               |
| `POST /contracts`                     | script text                 | Create a `contract` script (`201`); `409` if that version already exists         |
| `POST /run/<path>/<Name>`             | `{ "parameters": { ... } }` | Invoke the latest version of a saved contract (omit the body when parameterless) |
| `POST /run/<path>/<Name>@<n>`         | `{ "parameters": { ... } }` | Invoke a specific version of a saved contract                                    |
| `GET /contracts`                      | —                           | List every saved contract version and its parameters                             |
| `DELETE /contracts/<path>/<Name>`     | —                           | Delete every version of a contract                                               |
| `DELETE /contracts/<path>/<Name>@<n>` | —                           | Delete one version of a contract                                                 |

Errors are returned as `{ "error": { "type", "message" } }`: lex/parse, parameter, and malformed-version errors are `400`, an already-existing contract version is `409`, script runtime errors are `422`, unknown contracts/routes are `404`.

Contracts are created through the dedicated `POST /contracts` endpoint; posting a contract script to `/run` (or a request script to `/contracts`) is rejected with a hint.

Contracts are immutable and keyed by `(path, name, version)`. The version is declared in the contract source after the name — `contract path.to.MyContract@1.2.3(param1: string) { ... }` — as dot-separated numbers (`@2`, `@1.5`, `@1.2.3`, ...), defaulting to `1` when omitted. Saving a `(path, name, version)` that already exists is rejected with `409`; to change a contract, save the entire contract again under a new version. "Latest" is decided by comparing versions numerically segment by segment (`1.10` is newer than `1.9`).

## The language

RequestScript is a small, strictly typed scripting language with Typescript/Kotlin-flavoured syntax. This section is a complete reference for what this implementation accepts; [intro-guide.md](./intro-guide.md) is the original tutorial-style specification.

```
contract shop.orders.LineTotal@2(item: object, taxRate: decimal(1, 4)) {
    // Price a single line item
    var subtotal: decimal = 0
    subtotal = subtotal + item.price * item.quantity
    const total = subtotal + subtotal * taxRate

    if (total > 100 && item.giftWrap != true) {
        return { total: total, note: "Free shipping" }
    }

    return {
        total: total,
        note: "Taxed at ${taxRate * 100}%",
    }
}
```

Invoked with `{ "parameters": { "item": { "price": 9.99, "quantity": 2 }, "taxRate": 0.0825 } }`, this returns `{ "returnValue": { "total": 21.62835, "note": "Taxed at 8.25%" } }`.

### Lexical structure

- **Comments** start with `//` and run to the end of the line.
- **Whitespace and newlines** are insignificant, and statements need no separator (`var a = 1 var b = 2` is valid). The one exception is `return`: its value must start on the same line as the keyword, otherwise the `return` is bare.
- **Identifiers** are `[A-Za-z_][A-Za-z0-9_]*` and are case-sensitive.
- **Reserved keywords**: `request`, `contract`, `var`, `const`, `return`, `if`, `else`, `true`, `false`, `null`. Type names (`int32`, `string`, ...) are not reserved.
- **Number literals** are decimal digits, optionally with a fractional part: `42`, `3.14`. There are no exponent, hex, or digit-separator forms, and a leading `.` (`.5`) is not a number. Negative numbers are written with unary minus (`-5`).
- **String literals** use double quotes only and must fit on one line. Supported escapes are `\"`, `\\`, `\n`, `\t`, `\r`, and `\$`; any other escape is an error.

### Scripts and declarations

Every script is exactly one declaration followed by a `{ ... }` body. Nothing may come before or after it except comments.

**Request** scripts are one-off and take no parameters:

```
request MyRequest {
    return "Hello World!"
}
```

**Contract** scripts are saved on the server and invoked later, optionally with parameters:

```
contract path.to.MyContract@1.2.3(name: string, tags: []string,) {
    return "Hello ${name}"
}
```

- The name may be preceded by a dot-separated path. Path segments may be any word, including keywords (`contract if.else.Thing` is allowed).
- The optional `@<version>` is one or more dot-separated numbers with no spaces (`@2`, `@1.5`, `@1.2.3`, or deeper) and defaults to `1`. Versions are compared numerically per segment, with missing segments counting as 0, so `@1.10` is newer than `@1.9`. Versions are matched exactly as written, so `@1.0` and `@1` are distinct. See [HTTP API](#http-api) for how versions are stored and invoked.
- Parameters are `name: type` pairs, separated by commas, with an optional trailing comma. Names must be unique. A parameterless contract omits the parentheses entirely; `()` is an error.
- An optional return type follows the parameters after a colon: `contract shop.Total(items: []object): decimal { ... }`, or `contract shop.Count: int32 { ... }` without parameters. The value the contract returns is converted to that type like an assignment (`int32` widens to `decimal`, `null` is always allowed), and any other value is a runtime error. A contract without one may return anything.
- Parameters are `const` bindings. When invoked, every declared parameter must be supplied, unknown parameters are rejected, and each value is converted to its declared type (see [JSON encoding](#json-encoding)). Supplying parameters to a `request` script is an error.

### Types

| Type            | Values                                                                 | Notes                                          |
| --------------- | ---------------------------------------------------------------------- | ---------------------------------------------- |
| `int32`         | 32-bit signed integers                                                 | Range-checked; never wraps.                    |
| `int64`         | 64-bit signed integers                                                 | Backed by `BigInt`; never wraps.               |
| `decimal`       | Exact fixed-point decimals                                             | `0.1 + 0.2 == 0.3` is `true`.                  |
| `decimal(p, s)` | Decimals with at most `p` digits before and `s` digits after the point | Bounds are checked whenever a value is stored. |
| `boolean`       | `true`, `false`                                                        |                                                |
| `string`        | Text                                                                   |                                                |
| `object`        | String-keyed maps of any values                                        | Untyped; properties can hold any type.         |
| `[]T`           | Lists of `T`                                                           | Nestable: `[][]int32`.                         |

`null` is a value of every type: it can be assigned to any variable, parameter, or list element.

Numeric values are automatically promoted where a wider type is expected: `int32` to `int64`, and either integer type to `decimal`. An `int64` value is accepted where `int32` is expected only if it fits in range. No other implicit conversions exist; for example, a string is never converted to a number.

### Variables

```
var count: int32 = 0      // explicit type
var name = "Christopher"  // inferred as string
const limit = 10          // cannot be reassigned
```

- `var` declares a mutable variable, `const` an immutable one. Both require an initial value.
- When the type is omitted it is inferred from the value: integer literals that fit in 32 bits are `int32`, larger ones are `int64`; fractional literals are `decimal`; a list whose elements all share a type is a list of that type. A list with mixed element types, an empty list, or `null` infers an unconstrained type that accepts any value.
- A variable's type never changes. Reassigning a `var` (`count = count + 1`) checks the new value against the variable's type.
- Names cannot be redeclared, and this includes shadowing: declaring a name inside an `if` block that already exists in an enclosing scope is an error. Variables declared inside an `if` block are not visible after it.
- Object properties and list elements can be modified in place, even through a `const` binding, since `const` only prevents rebinding the name: `obj.color = "red"`, `list[0] = 5`. Assigning a property that doesn't exist adds it. These element and property assignments are not checked against a list's element type.

### Built-in variables

A host can pass values a script reads without declaring them, through the `builtins` option:

```ts
await interpret(source, { builtins: { jwt: { sub: "cli_1", org: "org_1" } } });
```

```
request ClientId {
    return jwt.sub
}
```

- Built-ins are constants, and read-only all the way down: `jwt = ...`, `jwt.sub = "x"` and `jwt.aud[0] = "x"` are runtime errors. So is changing one through another variable (`var copy = jwt` refers to the same value). Copy a field into a variable to work with it (`var sub = jwt.sub`).
- Their names are reserved: declaring a variable with a built-in's name, in any scope, is a runtime error, and so is a contract parameter with that name (a `ParameterError`).
- Values are converted like resource results: numbers become `int32`, `int64` or `decimal`, and objects and lists convert recursively. A `null` built-in still reserves its name.
- Names must be identifiers and not keywords; anything else throws a plain `Error`, since it is a host bug.

### Expressions

**Literals**: numbers, strings, `true`, `false`, `null`, objects, and lists.

```
const car = {
    brand: "Honda",
    owner: { name: "Ana" },
}
const colors = ["red", "green", "orange",]
```

Object keys are bare identifiers (quoted keys are not supported) and must be unique within a literal. Objects and lists both allow trailing commas.

**String interpolation**: `${expression}` inside a string evaluates any expression, including nested strings with their own interpolations (`"a ${"b ${c}"}"`). Values render as you would expect: numbers in plain decimal notation, booleans as `true`/`false`, `null` as `null`, and objects and lists as JSON. Write `\$` for a literal dollar sign before `{`.

**Access**:

- `obj.prop` reads a property. A missing property reads as `null`, while accessing a property on anything other than an object is an error.
- `list[i]` reads an element. The index must be an integer, and an out-of-bounds index is an error.

**Operators**, from lowest to highest precedence (all binary operators are left-associative):

| Precedence | Operators            | Operands                               |
| ---------- | -------------------- | -------------------------------------- |
| 1          | `\|\|`               | booleans; short-circuits               |
| 2          | `&&`                 | booleans; short-circuits               |
| 3          | `==` `!=`            | any values                             |
| 4          | `<` `<=` `>` `>=`    | two numbers, or two strings            |
| 5          | `+` `-`              | numbers; `+` also concatenates strings |
| 6          | `*` `/`              | numbers                                |
| 7          | unary `!`, unary `-` | boolean, number                        |

Parentheses group as usual. Operator semantics:

- **No truthiness.** `!`, `&&`, `||`, and `if` conditions require real booleans; `if (1)` is an error.
- **Equality** is deep for objects and lists, and compares numbers by value across types, so `1 == 1.0` is `true`. Values of different non-numeric types are never equal.
- **Comparison** orders numbers by value and strings lexicographically. Comparing anything else is an error.
- **`+` with a string** on either side converts the other side to a string (using the interpolation rules above) and concatenates.
- **Integer arithmetic** stays `int32` when both sides are `int32`, and becomes `int64` if either side is `int64`. A result outside the type's range raises an overflow error. Integer `/` truncates toward zero (`7 / 2` is `3`).
- **Decimal arithmetic** happens when either side is a `decimal`. Addition, subtraction, and multiplication are exact. Division rounds half away from zero at 10 decimal places, or at the larger operand's scale if that is greater (`1 / 3.0` is `0.3333333333`).
- Dividing by zero is an error for both integers and decimals.

There is no modulo operator, no compound assignment (`+=`), and no increment/decrement operator.

### Statements

- **Declarations**: `var` and `const`, as above.
- **Assignment**: `name = value`, `obj.prop = value`, `list[i] = value`.
- **Expression statements**: any expression on its own, which is mostly useful for calling a resource function for its side effect.
- **`if` / `else if` / `else`**: the condition must be in parentheses and the bodies in braces. Each body is its own scope.

  ```
  if (score >= 90 && !late) {
      return "A"
  } else if (score >= 80) {
      return "B"
  } else {
      return "C"
  }
  ```

- **`return`**: ends the script immediately. The value becomes the response's `returnValue`. A bare `return`, or reaching the end of the script without one, returns `null`.

There are no loops or user-defined functions.

### Resources

Resources expose host (Typescript) functions to scripts. A script binds one with a `const` declaration whose type is the resource's dotted path and name, then calls its functions with **named** arguments, in any order:

```
request MyRequest {
    const math: path.to.AddResource
    const sum = math.add(first: 2, second: 3)
    return sum.value
}
```

A call never evaluates to the bare return value. It always evaluates to a result object with exactly two properties — `value` and `error` — so a failing call is something the script can handle rather than something that ends it:

```
{ value: 5, error: null }                        // success
{ value: null, error: { message: "timed out" } } // failure
```

`error` is `null` on success, and on failure it is an object with a single `message` string. A result carries one or the other, never both, so a script checks `error` first:

```
request MyRequest {
    const weather: com.example.Weather

    const temperature = weather.temperature(city: "Oslo")

    if (temperature.error != null) {
        return temperature.error.message
    }

    return temperature.value
}
```

On the host side, a resource is a plain object:

```ts
import type { Resource } from "requestscript-js";

const addResource: Resource = {
  metadata: {},
  path: "path.to",
  name: "AddResource",
  functions: [
    {
      name: "add",
      parameters: [
        { name: "first", type: "int32" },
        { name: "second", type: "int32" },
      ],
      returnType: "int32", // any RequestScript type string, or 'void'
      exec: async (args) => {
        const first = args.find((a) => a.name === "first")!.value as number;
        const second = args.find((a) => a.name === "second")!.value as number;
        return first + second;
      },
    },
  ],
};
```

- Resource bindings must use `const` and have no `= value`. The resource is looked up when the declaration runs, and an unknown resource is an error at that point.
- A resource reference is not a value: it cannot be returned, stored in an object or list, interpolated, or read with `ref.fn` without a call.
- Every declared parameter must be passed, and unknown or duplicate argument names are errors. Arguments are checked and promoted against the declared parameter types.
- Arguments are passed to `exec` as host values: `int32` as `number`, `int64` as `bigint`, `decimal` as the exported `Decimal` class, `null` as `null`, and lists and objects as plain arrays and objects.
- `exec` returns the value itself, not a result object — the wrapping happens for it. It may be async. The returned value is converted to and validated against the declared return type; with `returnType: 'void'` the call produces `{ value: null, error: null }`.
- If `exec` throws, the thrown message becomes `error.message` and the script carries on. A type mismatch against `returnType` is still a `RuntimeError` that fails the script, because that is a bug in the host rather than a condition a script can act on.

Pass resources to `interpret` with `resourceResolver: createResourceResolver([...])`, or to the server with the `resourceResolver` option of `startServer`/`createApp`.

#### Custom invokers

By default resources are run by `defaultResourceInvoker`, which calls `exec` and wraps the result. Pass `resourceInvoker` to `interpret` to run them some other way — over HTTP to another service, say. An invoker receives the resolved resource, the function name, and the coerced arguments, and returns the result object directly; the `resourceValue` and `resourceError` helpers build it:

```ts
import { resourceError, resourceValue, type ResourceInvoker } from "requestscript-js";

const remoteInvoker: ResourceInvoker = {
  async invoke(resource, functionName, parameters) {
    const response = await fetch(url(resource, functionName), {
      method: "POST",
      body: JSON.stringify(parameters),
    });
    if (!response.ok) return resourceError(`${resource.name} returned ${response.status}`);
    return resourceValue(await response.json());
  },
};
```

An invoker may also throw, which is treated exactly like a thrown `exec`. The function name and arguments are validated before the invoker is called, so `invoke` only ever sees a function the resource declares with every parameter present.

### Token metering

Hosts can price and limit scripts by the tokens they execute. A token is one lexer token: an identifier, keyword, number, operator, punctuation mark, or a whole string literal however long.

Each statement and expression owns the tokens it was parsed from, minus those owned by its children, and the interpreter counts a node's tokens just before running it. So a run counts exactly the code it executed:

- The declaration (`request R`, or a contract's name, version and parameter list) and the body's outer braces are free.
- An `if` counts each condition it evaluates together with that branch's `if`/`else if`, parentheses and braces, then the body of the branch it takes. The `else` keyword and its braces count only when the else body runs. Untaken branches cost nothing.
- The operand a short-circuiting `&&` or `||` skips is not counted.
- A string counts as one token, plus the tokens of each `${}` interpolation as it is evaluated.
- Parentheses count with the expression that encloses them, and an assignment's target counts with the assignment.

```ts
import { interpret, maxTokens, parseScript, TokenMeter } from "requestscript-js";

const script = parseScript(source);
maxTokens(script); // the most any run can execute: each if takes its costliest path

const meter = new TokenMeter(10_000); // optional limit
const result = await interpret(source, { meter, signal });
result.usage.tokens; // also on meter.tokens, which survives a failed run
```

Because there are no loops or user-defined functions, `maxTokens` is a finite bound known before the script runs. A node that would take the count past the meter's limit is not run, and the script fails with `TokenLimitError` (a `RuntimeError`). `signal` is an `AbortSignal`, checked before each statement, expression and resource call.

### JSON encoding

A script's return value is encoded as JSON under `returnValue`. Lists and objects map to arrays and objects, and `int32`, `boolean`, `string`, and `null` map directly. `int64` and `decimal` values are encoded as JSON numbers when that is lossless, and otherwise as strings (e.g. `"9223372036854775807"`).

Contract parameters arrive as JSON and are converted to their declared types. Integers must be whole numbers within range. For `int64` and `decimal` parameters, strings are accepted too, so high-precision values can be sent without losing precision (`"amount": "12345678901234567.89"`). Inside `object` parameters, and for resource return types declared as `object`, values get inferred types: whole numbers become `int32` or `int64`, other numbers become `decimal`.

### Errors

Interpreter failures are thrown as typed errors, which the server maps to HTTP status codes:

- `LexError` and `ParseError` (HTTP `400`) cover malformed source: unknown characters, unterminated strings, unknown types, duplicate keys or parameters, a missing declaration, and so on. They carry a line and column.
- `ParameterError` (HTTP `400`) is raised for missing, unknown, or wrongly-typed contract parameters.
- `RuntimeError` (HTTP `422`) covers everything detected while running: type mismatches, unknown variables, redeclaration, assigning to a `const`, overflow, division by zero, out-of-bounds indexes, non-boolean conditions, and passing a meter's token limit (`TokenLimitError`). It carries a line number.

A resource function failing is not one of these. It is reported to the script as `error` on the call's result, and the request still succeeds — see [Resources](#resources).

## Project layout

- `src/lang/` — the language: lexer, parser, AST, exact `Decimal`, type checking/coercion, tree-walking interpreter, resource interfaces. Re-exported as the package root (`requestscript-js`).
- `src/server/` — the `requestscript-js/server` subpath: express app (`app.ts`), `startServer` bootstrap (`start.ts`), contract storage via drizzle (`contracts.ts`), database schema and migrations (`db/`).
- `src/bin/requestscript-server.ts` — the `requestscript-server` executable.
- `test/` — vitest suites covering the lexer, parser, decimal arithmetic, every language feature, resources, contract parameters, and the HTTP server (against embedded PGlite with the real migrations).
