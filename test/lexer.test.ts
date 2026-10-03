import { describe, expect, it } from 'vitest';
import { LexError } from '../src/lang/errors.js';
import { tokenize } from '../src/lang/lexer.js';

function types(source: string): string[] {
  return tokenize(source).map((token) => token.type);
}

describe('lexer', () => {
  it('tokenizes a minimal request script', () => {
    expect(types('request MyRequest { }')).toEqual(['request', 'identifier', '{', '}', 'eof']);
  });

  it('tokenizes keywords and identifiers separately', () => {
    const tokens = tokenize('var const return if else true false null contract myName');
    expect(tokens.map((token) => token.type)).toEqual([
      'var',
      'const',
      'return',
      'if',
      'else',
      'true',
      'false',
      'null',
      'contract',
      'identifier',
      'eof',
    ]);
    expect(tokens[9]!.value).toBe('myName');
  });

  it('tokenizes numbers', () => {
    const tokens = tokenize('123 45.67');
    expect(tokens[0]).toMatchObject({ type: 'int', value: '123' });
    expect(tokens[1]).toMatchObject({ type: 'decimal', value: '45.67' });
  });

  it('does not treat a trailing dot as part of a number', () => {
    expect(types('1.foo')).toEqual(['int', '.', 'identifier', 'eof']);
  });

  it('tokenizes operators', () => {
    expect(types('== != <= >= < > && || ! + - * / =')).toEqual([
      '==',
      '!=',
      '<=',
      '>=',
      '<',
      '>',
      '&&',
      '||',
      '!',
      '+',
      '-',
      '*',
      '/',
      '=',
      'eof',
    ]);
  });

  it('skips // comments to the end of the line', () => {
    expect(types('1 // comment with var if "string\n2')).toEqual(['int', 'int', 'eof']);
  });

  it('tracks line numbers', () => {
    const tokens = tokenize('a\nb\n\nc');
    expect(tokens.map((token) => token.line)).toEqual([1, 2, 4, 4]);
  });

  it('tokenizes plain strings', () => {
    const token = tokenize('"Hello World!"')[0]!;
    expect(token.type).toBe('string');
    expect(token.parts).toEqual([{ type: 'text', value: 'Hello World!' }]);
  });

  it('tokenizes the empty string', () => {
    expect(tokenize('""')[0]!.parts).toEqual([{ type: 'text', value: '' }]);
  });

  it('handles escape sequences', () => {
    const token = tokenize('"a\\"b\\\\c\\nd\\te\\$f"')[0]!;
    expect(token.parts).toEqual([{ type: 'text', value: 'a"b\\c\nd\te$f' }]);
  });

  it('rejects unknown escape sequences', () => {
    expect(() => tokenize('"\\q"')).toThrow(LexError);
  });

  it('splits interpolated strings into parts', () => {
    const token = tokenize('"Hello ${name}!"')[0]!;
    expect(token.parts).toHaveLength(3);
    expect(token.parts![0]).toEqual({ type: 'text', value: 'Hello ' });
    expect(token.parts![1]!.type).toBe('expr');
    expect(token.parts![2]).toEqual({ type: 'text', value: '!' });
  });

  it('tokenizes interpolation expressions including nested braces', () => {
    const token = tokenize('"${ myObj.car }"')[0]!;
    const expr = token.parts![0]!;
    if (expr.type !== 'expr') throw new Error('expected expr part');
    expect(expr.tokens.map((t) => t.type)).toEqual(['identifier', '.', 'identifier', 'eof']);
  });

  it('supports nested strings inside interpolations', () => {
    const token = tokenize('"a${"b${c}"}d"')[0]!;
    expect(token.parts!.map((part) => part.type)).toEqual(['text', 'expr', 'text']);
  });

  it('escaped dollar does not start an interpolation', () => {
    const token = tokenize('"\\${name}"')[0]!;
    expect(token.parts).toEqual([{ type: 'text', value: '${name}' }]);
  });

  it('rejects unterminated strings', () => {
    expect(() => tokenize('"abc')).toThrow(LexError);
    expect(() => tokenize('"abc\ndef"')).toThrow(LexError);
  });

  it('rejects unterminated interpolations', () => {
    expect(() => tokenize('"${abc"')).toThrow(LexError);
  });

  it('rejects empty interpolations', () => {
    expect(() => tokenize('"${}"')).toThrow(LexError);
  });

  it('tokenizes the version marker', () => {
    expect(tokenize('C@2').map((token) => token.type)).toEqual(['identifier', '@', 'int', 'eof']);
  });

  it('rejects unexpected characters', () => {
    expect(() => tokenize('#')).toThrow(LexError);
  });
});
