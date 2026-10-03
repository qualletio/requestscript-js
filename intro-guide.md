# Requestscript

Welcome to RequestScript! RequestScript is a portable programming language and interpreter. Requestscript's syntax is based on Typescript and Kotlin.

RequestScript is mostly intended to run in the body of an http request to a RequestScript server like so:
POST /run

```
request MyRequest {
    return "Hello World!"
}
```

The following is the basics of the language and how it should function.

## Request declaration

A RequestScript script starts with the request declaration.
This declaration is where the "meta" of a request is declared. The request's name, type, and parameters.

### Request type

A Request request type is a one-off request sent to the server. It does not have parameters.
It looks like so:

```
request MyRequest {
    // Script body goes here
}
```

A comment is a line of the script that is ignored and used to help the user. Start the line of a comment with `//`.

The declaration always goes "type" "name" "optional parameters".

### Contract type

A Contract request type is a rerunnable script that is saved to the server and ran on command. Contracts can have parameters:

```
contract path.to.contract.MyContract(param1: string) {
    // Script body goes here
}
```

The contract name is preceded by its path. Two contracts can have the same name, but only one contract can exist at a path with that name.

If a contract does not have parameters, the parentheses are excluded:

```
contract MyParameterlessContract {
    // Script body goes here
}
```

Parameters are specified by a parameter name, and its type (one of `int32`, `int64`, `decimal`, `boolean`, `string`, `object`, or square brackets followed by a type to indicate a list: `[]int32`)

A contract is invoked with json to the http server.
The url is the path to the contract ending with the contract's name.
The http method is `POST`.
The body of the request is a JSON object that takes in an subobject of parameters. If the contract does not have parameters, the object is excluded.

Example:

url: /run/path/to/MyContract
body:

```json
{
    "parameters": {
        "param1:" "Hello World!"
    }
}
```

## Types

RequestScript supports a number of built in types. These are the following:
`int32`, `int64`, `decimal`, `boolean`, `string`, `object`, or square brackets followed by a type to indicate a list: `[]int32`.

### Decimals

Decimals are declared with the number of places before and after the decimal point:

```
request MyRequest {
    var myVar: decimal(4, 3) = 1234.567
}
```

### Booleans

Booleans are declared with either the value `true` or `false`.

### Strings

Strings are declared inside quote marks:

```
request MyRequest {
    var myVar: string = "Hello World!"
}
```

Expressions can be interpolated into Strings like Kotlin:

```
request MyRequest {
    var name: string = "Christopher"
    var myVar: string = "Hello ${name}"
}
```

Anything within `${` and `}` will be executed as an expression.

### Objects

Objects are complex types made of other types and are similar to Typescript objects:

```
request MyRequest {
    var myObj: object = {
        color: "Yellow",
        car: {
            brand: "Honda",
        },
    }
}
```

On objects, lists, and parameters, trailing commas are supported.

The property of an object is referenced by name using dot notation:

```
request MyRequest {
    var myObj: object = {
        color: "Yellow",
        car: {
            brand: "Honda",
        },
    }

    return myObj.color
}
```

Lists are a grouping of other types and are similar to Typescript arrays/lists:

```
request MyRequest {
    var myColors: []string = [
        "red",
        "green",
        "orange",
    ]
}
```

An item in a list can be referenced with index notation:

```
request MyRequest {
    var myColors: []string = [
        "red",
        "green",
        "orange",
    ]

    return myColors[1]
}
```

## Variables

Variables store data.

The `var` keyword declares a mutable variable. After the `var` keyword, declare the variable name, then colon, type, then value. The type may be omitted and will be inferred from the value.

```
request MyRequest {
    var myVar: string = "test"
}
```

Omitting the type:

```
request MyRequest {
    var myVar = "test"
}
```

Variables cannot change type. Once a variable is declared, it cannot be redeclared with the `var` keyword or the `const` keyword.

### Const variables

The `const` keyword is used to declare a variable that cannot change:

```
request MyRequest {
    const myVar = "Test"
}
```

All the features of a var variable apply to a const variable.

## Return Statement

The return statement is used to return a value from the script execution and immediately stop execution:

```
request MyRequest {
    return "Test"
}
```

A return statement can be a raw value (like a string) or a variable:

```
request MyRequest {
    var myVar = 123

    return myVar
}
```

Any expressions after a return are skipped and ignored.

On an http response, the return value is encoded to JSON with the `returnValue` key:

```json
{
  "returnValue": 123
}
```

The `returnValue` key will have a different type depending on the return type. For example, it could be a string, object, list, etc.

If a script has no return statement, then `returnValue` is `null`.

## Control Statements

## If Statement

An if statement determines whether the code within it executes.
An if statement starts with the `if` keyword, then a boolean expression condition in parentheses, then a block of code to execute if the statement passes within curly braces.

```
request MyRequest {
    if (true) {
        return "Passed"
    }
}
```

Any expression that resolves to a boolean value can be put in the if statement condition, like variables:

```
request MyRequest {
    var myVar = true

    if (myVar) {
        return "Passed"
    }
}
```

If statements work like they do in other languages. You can use `&&` for AND conditionals, `||` for OR conditionals, `!` at the front of the expression to negate the expression, parentheses to help determine ordering.

If statements can have `else if` branches to declare what happens if the previous condition fails:

```
request MyRequest {
    if (false) {
        return "Failed"
    } else if (true) {
        return "Passed"
    }
}
```

The `else` branch can be used to execute when all other branches fail:

```
request MyRequest {
    if (false) {
        return "Failed"
    } else {
        return "Passed"
    }
}
```

## Resources

Resources act as a way to execute actions in the host language.
The host language in this case, being Typescript.

Resources are declared in Typescript and passed into the Requestscript interpreter.
The interpreter can then call the functions declared of resources when they are referenced in Requestscript.

For example:

```typescript
export interface Resource {
    path: string;
    name: string;
    functions: ResourceFunction[];
}

export interface ResourceFunction {
    name: string;
    parameters: [
        name: string;
        type: string;
    ];
    exec: (args: ResourceFunctionCallParameter[]) => any;
    returnType: string;
}

export interface ResourceFunctionCallParameter {
    name: string;
    value: any;
}

const addResource: Resource = {
    path: "path.to",
    name: "AddResource",
    functions: [
        {
            name: "add",
            parameters: [
                {
                    name: "first",
                    type: "int32",
                },
                {
                    name: "second",
                    type: "int32",
                }
            ],
            exec: (args: ResourceFunctionCallParameter[]) => {
                const first = Number(args.find((parameter) => parameter.name == "first"))
                const second = Number(args.find((parameter) => parameter.name == "second"))

                return first + second
            },
            returnType: "int32",
        }
    ]
}
```

Can be executed from Requestscript with the following syntax:

```
request MyRequest {
    // First we declare the reference to the resource
    const addResource: path.to.AddResource

    const num1 = 2
    const num2 = 3

    // Now we can reference functions of the resource
    return addResource.add(first: num1, second: num2)
}
```

The interpreter should find the resource at the path with that name and call this function passing the values from the Requestscript variables. The return of the function (if it is not void) should be passed back into Requestscript.

## Server

Contracts are stored on the server and accessed by the interpreter engine using the drizzle library. The shape of the contract table is managed with database migrations.

## Tests

There should be comprehensive test coverage for the full behavior of the Requestscript language and interpreter.
