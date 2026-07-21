import { describe, expect, it } from 'vitest';
import { RuntimeError } from '../src/lang/errors.js';
import { run, runBody } from './helpers.js';

describe('interpreter: basics', () => {
  it('returns a string', async () => {
    expect(await run('request MyRequest { return "Hello World!" }')).toBe('Hello World!');
  });

  it('returns null when there is no return statement', async () => {
    expect(await run('request R { var x = 1 }')).toBeNull();
  });

  it('returns null for a bare return', async () => {
    expect(await runBody('return')).toBeNull();
  });

  it('stops execution at the first return', async () => {
    expect(await runBody('return 1\nreturn 2')).toBe(1);
  });

  it('ignores comments', async () => {
    expect(await runBody('// a comment\nreturn 1 // trailing')).toBe(1);
  });

  it('returns literals of every simple kind', async () => {
    expect(await runBody('return 123')).toBe(123);
    expect(await runBody('return 12.5')).toBe(12.5);
    expect(await runBody('return true')).toBe(true);
    expect(await runBody('return false')).toBe(false);
    expect(await runBody('return null')).toBeNull();
  });
});

describe('interpreter: variables', () => {
  it('declares and returns variables', async () => {
    expect(await runBody('var myVar: string = "test"\nreturn myVar')).toBe('test');
    expect(await runBody('var myVar = "test"\nreturn myVar')).toBe('test');
  });

  it('supports reassignment of var', async () => {
    expect(await runBody('var x = 1\nx = 2\nreturn x')).toBe(2);
  });

  it('rejects reassignment of const', async () => {
    await expect(runBody('const x = 1\nx = 2')).rejects.toThrow(/const/);
  });

  it('rejects redeclaration with var or const', async () => {
    await expect(runBody('var x = 1\nvar x = 2')).rejects.toThrow(/already declared/);
    await expect(runBody('var x = 1\nconst x = 2')).rejects.toThrow(/already declared/);
    await expect(runBody('const x = 1\nvar x = 2')).rejects.toThrow(/already declared/);
  });

  it('rejects redeclaration from an inner scope', async () => {
    await expect(runBody('var x = 1\nif (true) { var x = 2 }')).rejects.toThrow(/already declared/);
  });

  it('rejects changing a variable type', async () => {
    await expect(runBody('var x = "text"\nx = 1')).rejects.toThrow(RuntimeError);
    await expect(runBody('var x = 1\nx = "text"')).rejects.toThrow(RuntimeError);
    await expect(runBody('var x = true\nx = 1.5')).rejects.toThrow(RuntimeError);
  });

  it('enforces annotated types on declaration', async () => {
    await expect(runBody('var x: string = 1')).rejects.toThrow(/Cannot use a int32 value as string/);
    await expect(runBody('var x: boolean = "no"')).rejects.toThrow(RuntimeError);
    await expect(runBody('var x: []string = [1]')).rejects.toThrow(RuntimeError);
  });

  it('enforces the declared type on later assignments', async () => {
    await expect(runBody('var x: []string = []\nx = [1]')).rejects.toThrow(RuntimeError);
    expect(await runBody('var x: []string = []\nx = ["ok"]\nreturn x[0]')).toBe('ok');
  });

  it('rejects use of unknown variables', async () => {
    await expect(runBody('return nope')).rejects.toThrow(/Unknown variable 'nope'/);
    await expect(runBody('nope = 1')).rejects.toThrow(/Unknown variable 'nope'/);
  });

  it('allows null to be assigned to any type', async () => {
    expect(await runBody('var x: string = null\nreturn x')).toBeNull();
    expect(await runBody('var x: int32 = 1\nx = null\nreturn x')).toBeNull();
  });

  it('variables declared in an if branch are scoped to it', async () => {
    await expect(runBody('if (true) { var y = 1 }\nreturn y')).rejects.toThrow(/Unknown variable 'y'/);
  });
});

describe('interpreter: numbers', () => {
  it('infers int32 for small integers and int64 for large ones', async () => {
    expect(await runBody('return 3000000000')).toBe(3000000000);
    expect(await runBody('var x: int64 = 5\nreturn x + 2147483647 - 2')).toBe(2147483650);
  });

  it('promotes int32 to int64 on annotated declarations', async () => {
    expect(await runBody('var x: int64 = 5\nreturn x')).toBe(5);
  });

  it('rejects out-of-range int32 assignments', async () => {
    await expect(runBody('var x: int32 = 3000000000')).rejects.toThrow(/out of range for int32/);
  });

  it('int32 arithmetic overflows with an error', async () => {
    await expect(runBody('return 2147483647 + 1')).rejects.toThrow(/int32 overflow/);
    await expect(runBody('var x: int64 = 2147483647\nreturn x + 1')).resolves.toBe(2147483648);
  });

  it('int64 arithmetic overflows with an error', async () => {
    await expect(runBody('return 9223372036854775807 + 1')).rejects.toThrow(/int64 overflow/);
  });

  it('encodes unsafe int64 values as JSON strings', async () => {
    expect(await runBody('return 9223372036854775807')).toBe('9223372036854775807');
    expect(await runBody('return 123')).toBe(123);
  });

  it('integer division truncates', async () => {
    expect(await runBody('return 7 / 2')).toBe(3);
    expect(await runBody('return -7 / 2')).toBe(-3);
  });

  it('rejects integer division by zero', async () => {
    await expect(runBody('return 1 / 0')).rejects.toThrow(/Division by zero/);
  });

  it('decimal arithmetic is exact', async () => {
    expect(await runBody('return 0.1 + 0.2')).toBe(0.3);
    expect(await runBody('return 0.1 + 0.2 == 0.3')).toBe(true);
    expect(await runBody('return 0.3 - 0.1')).toBe(0.2);
    expect(await runBody('return 0.1 * 0.1')).toBe(0.01);
  });

  it('mixing ints and decimals produces decimals', async () => {
    expect(await runBody('return 1 + 0.5')).toBe(1.5);
    expect(await runBody('return 7.0 / 2')).toBe(3.5);
  });

  it('decimal division rounds at scale 10', async () => {
    expect(await runBody('return 1.0 / 3')).toBe(0.3333333333);
  });

  it('enforces decimal digit constraints', async () => {
    expect(await runBody('var x: decimal(4, 3) = 1234.567\nreturn x')).toBe(1234.567);
    await expect(runBody('var x: decimal(3, 3) = 1234.567')).rejects.toThrow(/digits before the decimal point/);
    await expect(runBody('var x: decimal(4, 2) = 1234.567')).rejects.toThrow(/digits after the decimal point/);
  });

  it('promotes integers assigned to decimal variables', async () => {
    expect(await runBody('var x: decimal = 5\nreturn x + 0.5')).toBe(5.5);
  });

  it('supports unary minus', async () => {
    expect(await runBody('return -5')).toBe(-5);
    expect(await runBody('return -(1 + 2)')).toBe(-3);
    expect(await runBody('return -1.5')).toBe(-1.5);
    expect(await runBody('var x = 3\nreturn -x')).toBe(-3);
  });

  it('preserves precision far beyond doubles', async () => {
    expect(await runBody('return 123456789123456789.123456789 + 0.000000001')).toBe(
      '123456789123456789.12345679',
    );
  });
});

describe('interpreter: strings', () => {
  it('interpolates variables', async () => {
    expect(await runBody('var name: string = "Christopher"\nvar v: string = "Hello ${name}"\nreturn v')).toBe(
      'Hello Christopher',
    );
  });

  it('interpolates arbitrary expressions', async () => {
    expect(await runBody('return "sum=${1 + 2}"')).toBe('sum=3');
    expect(await runBody('return "neg=${!true}"')).toBe('neg=false');
    expect(await runBody('var o = { a: 1 }\nreturn "a=${o.a}"')).toBe('a=1');
  });

  it('interpolates every value kind', async () => {
    expect(await runBody('return "${1} ${1.5} ${true} ${null} ${"txt"}"')).toBe('1 1.5 true null txt');
  });

  it('renders objects and lists as JSON inside interpolations', async () => {
    expect(await runBody('return "${[1, 2]}"')).toBe('[1,2]');
    expect(await runBody('return "${{ a: 1 }}"')).toBe('{"a":1}');
  });

  it('supports nested interpolation', async () => {
    expect(await runBody('var x = "in"\nreturn "a${"b${x}"}c"')).toBe('abinc');
  });

  it('concatenates with + and converts operands', async () => {
    expect(await runBody('return "a" + "b"')).toBe('ab');
    expect(await runBody('return "n=" + 5')).toBe('n=5');
    expect(await runBody('return 5 + "=n"')).toBe('5=n');
    expect(await runBody('return "v" + true')).toBe('vtrue');
  });

  it('compares strings lexicographically', async () => {
    expect(await runBody('return "apple" < "banana"')).toBe(true);
    expect(await runBody('return "b" >= "b"')).toBe(true);
  });
});

describe('interpreter: objects and lists', () => {
  it('accesses object properties with dot notation', async () => {
    const body = `var myObj: object = {
      color: "Yellow",
      car: {
        brand: "Honda",
      },
    }
    return myObj.color`;
    expect(await runBody(body)).toBe('Yellow');
  });

  it('accesses nested properties', async () => {
    expect(await runBody('var o = { car: { brand: "Honda" } }\nreturn o.car.brand')).toBe('Honda');
  });

  it('returns null for missing properties', async () => {
    expect(await runBody('var o = { a: 1 }\nreturn o.b')).toBeNull();
  });

  it('rejects property access on non-objects', async () => {
    await expect(runBody('var s = "x"\nreturn s.length')).rejects.toThrow(/Cannot access property/);
    await expect(runBody('return null.a')).rejects.toThrow(/Cannot access property/);
  });

  it('returns whole objects as JSON', async () => {
    expect(await runBody('return { color: "Yellow", car: { brand: "Honda" } }')).toEqual({
      color: 'Yellow',
      car: { brand: 'Honda' },
    });
  });

  it('indexes lists', async () => {
    const body = `var myColors: []string = [
      "red",
      "green",
      "orange",
    ]
    return myColors[1]`;
    expect(await runBody(body)).toBe('green');
  });

  it('supports expressions as indexes', async () => {
    expect(await runBody('var l = [10, 20, 30]\nreturn l[1 + 1]')).toBe(30);
  });

  it('rejects out-of-bounds and non-integer indexes', async () => {
    await expect(runBody('var l = [1]\nreturn l[1]')).rejects.toThrow(/out of bounds/);
    await expect(runBody('var l = [1]\nreturn l[-1]')).rejects.toThrow(/out of bounds/);
    await expect(runBody('var l = [1]\nreturn l["0"]')).rejects.toThrow(/must be an integer/);
    await expect(runBody('return "abc"[0]')).rejects.toThrow(/Cannot index/);
  });

  it('mutates object properties and list elements', async () => {
    expect(await runBody('var o = { a: 1 }\no.a = 2\no.b = 3\nreturn o')).toEqual({ a: 2, b: 3 });
    expect(await runBody('var l = [1, 2]\nl[0] = 9\nreturn l')).toEqual([9, 2]);
  });

  it('returns lists of mixed content', async () => {
    expect(await runBody('return [1, "two", true, null, [2], { a: 1 }]')).toEqual([
      1,
      'two',
      true,
      null,
      [2],
      { a: 1 },
    ]);
  });
});

describe('interpreter: control flow', () => {
  it('runs if branches', async () => {
    expect(await runBody('if (true) { return "Passed" }')).toBe('Passed');
    expect(await runBody('if (false) { return "Failed" }\nreturn "After"')).toBe('After');
  });

  it('accepts any boolean expression as a condition', async () => {
    expect(await runBody('var v = true\nif (v) { return "Passed" }')).toBe('Passed');
    expect(await runBody('if (1 < 2 && !false) { return "Passed" }')).toBe('Passed');
  });

  it('runs else if and else branches', async () => {
    expect(await runBody('if (false) { return "a" } else if (true) { return "b" }')).toBe('b');
    expect(await runBody('if (false) { return "a" } else if (false) { return "b" } else { return "c" }')).toBe('c');
  });

  it('rejects non-boolean conditions', async () => {
    await expect(runBody('if (1) { return 1 }')).rejects.toThrow(/must be a boolean/);
    await expect(runBody('if ("yes") { return 1 }')).rejects.toThrow(/must be a boolean/);
  });

  it('short-circuits && and ||', async () => {
    // The right side would fail with division by zero if evaluated.
    expect(await runBody('if (false && 1 / 0 == 1) { return "bad" }\nreturn "ok"')).toBe('ok');
    expect(await runBody('if (true || 1 / 0 == 1) { return "ok" }')).toBe('ok');
  });

  it('rejects non-boolean logical operands', async () => {
    await expect(runBody('return 1 && true')).rejects.toThrow(/requires booleans/);
    await expect(runBody('return true && 1')).rejects.toThrow(/requires booleans/);
  });
});

describe('interpreter: equality and comparison', () => {
  it('compares numbers across kinds by value', async () => {
    expect(await runBody('return 1 == 1.0')).toBe(true);
    expect(await runBody('var x: int64 = 1\nreturn x == 1')).toBe(true);
    expect(await runBody('return 2 < 2.5')).toBe(true);
    expect(await runBody('return 3 >= 3')).toBe(true);
  });

  it('compares strings and booleans', async () => {
    expect(await runBody('return "a" == "a"')).toBe(true);
    expect(await runBody('return true != false')).toBe(true);
  });

  it('deep-compares lists and objects', async () => {
    expect(await runBody('return [1, [2]] == [1, [2]]')).toBe(true);
    expect(await runBody('return { a: 1, b: { c: 2 } } == { b: { c: 2 }, a: 1 }')).toBe(true);
    expect(await runBody('return { a: 1 } == { a: 2 }')).toBe(false);
    expect(await runBody('return [1] == [1, 2]')).toBe(false);
  });

  it('null equality', async () => {
    expect(await runBody('return null == null')).toBe(true);
    expect(await runBody('var o = { }\nreturn o.missing == null')).toBe(true);
  });

  it('values of different kinds are not equal', async () => {
    expect(await runBody('return 1 == "1"')).toBe(false);
    expect(await runBody('return true == 1')).toBe(false);
  });

  it('rejects ordering comparisons between incompatible kinds', async () => {
    await expect(runBody('return 1 < "2"')).rejects.toThrow(/cannot compare/);
    await expect(runBody('return true < false')).rejects.toThrow(/cannot compare/);
  });

  it('rejects arithmetic on non-numbers', async () => {
    await expect(runBody('return true + 1')).rejects.toThrow(/cannot be applied/);
    await expect(runBody('return [1] - [2]')).rejects.toThrow(/cannot be applied/);
  });
});
