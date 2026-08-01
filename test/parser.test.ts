import { describe, expect, it } from 'vitest';
import type { ContractDecl, IfStatement, VarDeclStatement } from '../src/lang/ast.js';
import { ParseError } from '../src/lang/errors.js';
import { parseScript, parseTypeString } from '../src/lang/parser.js';

describe('parser: declarations', () => {
  it('parses a request declaration', () => {
    const script = parseScript('request MyRequest { }');
    expect(script.declaration).toEqual({ kind: 'request', name: 'MyRequest' });
    expect(script.body).toEqual([]);
  });

  it('parses a contract declaration with a path and parameters', () => {
    const script = parseScript('contract path.to.contract.MyContract(param1: string) { }');
    const declaration = script.declaration as ContractDecl;
    expect(declaration.kind).toBe('contract');
    expect(declaration.path).toEqual(['path', 'to', 'contract']);
    expect(declaration.name).toBe('MyContract');
    expect(declaration.version).toBe('1');
    expect(declaration.parameters).toEqual([{ name: 'param1', type: { kind: 'string' } }]);
  });

  it('parses a parameterless contract without parentheses', () => {
    const script = parseScript('contract MyParameterlessContract { }');
    const declaration = script.declaration as ContractDecl;
    expect(declaration.path).toEqual([]);
    expect(declaration.parameters).toEqual([]);
  });

  it('parses a declared contract version', () => {
    const script = parseScript('contract path.to.MyContract@3(param1: string) { }');
    const declaration = script.declaration as ContractDecl;
    expect(declaration.name).toBe('MyContract');
    expect(declaration.version).toBe('3');
    expect(declaration.parameters).toEqual([{ name: 'param1', type: { kind: 'string' } }]);
  });

  it('parses a version on a parameterless contract', () => {
    const script = parseScript('contract C@12 { }');
    expect((script.declaration as ContractDecl).version).toBe('12');
  });

  it('parses decimal and semantic versions', () => {
    const version = (source: string) => (parseScript(source).declaration as ContractDecl).version;
    expect(version('contract C@1.5 { }')).toBe('1.5');
    expect(version('contract C@1.2.3 { }')).toBe('1.2.3');
    expect(version('contract C@0.1.0 { }')).toBe('0.1.0');
    expect(version('contract C@10.20.30.40 { }')).toBe('10.20.30.40');
    expect(version('contract a.b.C@2.0(p: string) { }')).toBe('2.0');
  });

  it('rejects invalid contract versions', () => {
    expect(() => parseScript('contract C@ { }')).toThrow(ParseError);
    expect(() => parseScript('contract C@v2 { }')).toThrow(ParseError);
    expect(() => parseScript('contract C@1. { }')).toThrow(ParseError);
    expect(() => parseScript('contract C@1..2 { }')).toThrow(ParseError);
    expect(() => parseScript('contract C@1.x { }')).toThrow(ParseError);
    expect(() => parseScript('contract C@1 .2 { }')).toThrow(ParseError);
    expect(() => parseScript('contract C@1. 2 { }')).toThrow(ParseError);
    expect(() => parseScript('request R@1 { }')).toThrow(ParseError);
  });

  it('parses list and decimal parameter types with trailing commas', () => {
    const script = parseScript('contract C(a: []int32, b: decimal(4, 3), c: [][]string,) { }');
    const declaration = script.declaration as ContractDecl;
    expect(declaration.parameters).toEqual([
      { name: 'a', type: { kind: 'list', element: { kind: 'int32' } } },
      { name: 'b', type: { kind: 'decimal', intDigits: 4, fracDigits: 3 } },
      { name: 'c', type: { kind: 'list', element: { kind: 'list', element: { kind: 'string' } } } },
    ]);
  });

  it('rejects scripts that do not start with request or contract', () => {
    expect(() => parseScript('var x = 1')).toThrow(ParseError);
    expect(() => parseScript('')).toThrow(ParseError);
  });

  it('rejects empty parameter lists', () => {
    expect(() => parseScript('contract C() { }')).toThrow(ParseError);
  });

  it('rejects duplicate parameters', () => {
    expect(() => parseScript('contract C(a: int32, a: string) { }')).toThrow(ParseError);
  });

  it('rejects trailing garbage after the script body', () => {
    expect(() => parseScript('request R { } extra')).toThrow(ParseError);
  });

  it('rejects unknown types', () => {
    expect(() => parseScript('contract C(a: number) { }')).toThrow(ParseError);
    expect(() => parseScript('request R { var x: number = 1 }')).toThrow(ParseError);
  });
});

describe('parser: statements', () => {
  it('parses var declarations with and without type annotations', () => {
    const script = parseScript('request R { var a: string = "x" \n var b = 2 }');
    const [first, second] = script.body as VarDeclStatement[];
    expect(first).toMatchObject({ kind: 'varDecl', constant: false, name: 'a', type: { kind: 'string' } });
    expect(second!.type).toBeUndefined();
  });

  it('parses const declarations', () => {
    const script = parseScript('request R { const a = 1 }');
    expect(script.body[0]).toMatchObject({ kind: 'varDecl', constant: true, name: 'a' });
  });

  it('parses resource reference declarations', () => {
    const script = parseScript('request R { const addResource: path.to.AddResource }');
    expect(script.body[0]).toEqual({
      kind: 'resourceDecl',
      name: 'addResource',
      resourcePath: ['path', 'to'],
      resourceName: 'AddResource',
      line: 1,
    });
  });

  it('parses path-less resource references', () => {
    const script = parseScript('request R { const r: MyResource }');
    expect(script.body[0]).toMatchObject({ kind: 'resourceDecl', resourcePath: [], resourceName: 'MyResource' });
  });

  it('rejects resource references declared with var', () => {
    expect(() => parseScript('request R { var r: path.to.Res }')).toThrow(ParseError);
  });

  it('rejects declarations without an initializer', () => {
    expect(() => parseScript('request R { var x: string }')).toThrow(ParseError);
  });

  it('parses bare and valued returns using line breaks', () => {
    const script = parseScript('request R { return\nreturn 1 }');
    expect(script.body[0]).toEqual({ kind: 'return', line: 1 });
    expect(script.body[1]).toMatchObject({ kind: 'return', value: { kind: 'intLiteral', value: 1n } });
  });

  it('parses assignments to variables, members, and indexes', () => {
    const script = parseScript('request R { x = 1\n x.y = 2\n x[0] = 3 }');
    expect(script.body.map((statement) => statement.kind)).toEqual(['assign', 'assign', 'assign']);
  });

  it('rejects invalid assignment targets', () => {
    expect(() => parseScript('request R { 1 = 2 }')).toThrow(ParseError);
  });

  it('parses if / else if / else chains', () => {
    const script = parseScript('request R { if (a) { } else if (b) { } else { return 1 } }');
    const statement = script.body[0] as IfStatement;
    expect(statement.branches).toHaveLength(2);
    expect(statement.elseBody).toHaveLength(1);
  });
});

describe('parser: expressions', () => {
  function firstReturnValue(body: string) {
    const script = parseScript(`request R { return ${body} }`);
    const statement = script.body[0]!;
    if (statement.kind !== 'return') throw new Error('expected return');
    return statement.value!;
  }

  it('parses operator precedence correctly', () => {
    // 1 + 2 * 3 == 7 && true  parses as  ((1 + (2*3)) == 7) && true
    const expr = firstReturnValue('1 + 2 * 3 == 7 && true');
    expect(expr).toMatchObject({
      kind: 'binary',
      operator: '&&',
      left: {
        kind: 'binary',
        operator: '==',
        left: { kind: 'binary', operator: '+', right: { kind: 'binary', operator: '*' } },
      },
    });
  });

  it('parses parenthesized grouping', () => {
    const expr = firstReturnValue('(1 + 2) * 3');
    expect(expr).toMatchObject({ kind: 'binary', operator: '*', left: { kind: 'binary', operator: '+' } });
  });

  it('parses unary operators', () => {
    expect(firstReturnValue('!true')).toMatchObject({ kind: 'unary', operator: '!' });
    expect(firstReturnValue('-5')).toMatchObject({ kind: 'unary', operator: '-' });
    expect(firstReturnValue('!!false')).toMatchObject({ kind: 'unary', operand: { kind: 'unary' } });
  });

  it('parses member and index chains', () => {
    const expr = firstReturnValue('a.b[1].c');
    expect(expr).toMatchObject({
      kind: 'member',
      property: 'c',
      object: { kind: 'index', object: { kind: 'member', property: 'b' } },
    });
  });

  it('parses object literals with nesting and trailing commas', () => {
    const expr = firstReturnValue('{ color: "Yellow", car: { brand: "Honda", }, }');
    expect(expr).toMatchObject({ kind: 'objectLiteral' });
    expect((expr as { entries: unknown[] }).entries).toHaveLength(2);
  });

  it('rejects duplicate object keys', () => {
    expect(() => firstReturnValue('{ a: 1, a: 2 }')).toThrow(ParseError);
  });

  it('parses list literals with trailing commas', () => {
    const expr = firstReturnValue('[1, 2, 3,]');
    expect(expr).toMatchObject({ kind: 'listLiteral' });
    expect((expr as { elements: unknown[] }).elements).toHaveLength(3);
  });

  it('parses calls with named arguments', () => {
    const expr = firstReturnValue('res.add(first: 1, second: 2,)');
    expect(expr).toMatchObject({
      kind: 'call',
      callee: { kind: 'member', property: 'add' },
      args: [{ name: 'first' }, { name: 'second' }],
    });
  });

  it('rejects positional call arguments', () => {
    expect(() => firstReturnValue('res.add(1, 2)')).toThrow(ParseError);
  });

  it('rejects duplicate call arguments', () => {
    expect(() => firstReturnValue('res.add(a: 1, a: 2)')).toThrow(ParseError);
  });

  it('parses interpolated strings into template expressions', () => {
    const expr = firstReturnValue('"Hello ${name}!"');
    expect(expr).toMatchObject({ kind: 'templateString' });
  });

  it('parses plain strings into string literals', () => {
    expect(firstReturnValue('"Hello"')).toEqual({ kind: 'stringLiteral', value: 'Hello', line: 1 });
  });

  it('parses null literals', () => {
    expect(firstReturnValue('null')).toMatchObject({ kind: 'nullLiteral' });
  });
});

describe('parseTypeString', () => {
  it('parses builtin and list types', () => {
    expect(parseTypeString('int32')).toEqual({ kind: 'int32' });
    expect(parseTypeString('[]string')).toEqual({ kind: 'list', element: { kind: 'string' } });
    expect(parseTypeString('decimal(10, 2)')).toEqual({ kind: 'decimal', intDigits: 10, fracDigits: 2 });
  });

  it('rejects invalid type strings', () => {
    expect(() => parseTypeString('nope')).toThrow(ParseError);
    expect(() => parseTypeString('int32 extra')).toThrow(ParseError);
  });
});
