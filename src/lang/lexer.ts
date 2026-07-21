import { LexError } from './errors.js';
import { KEYWORDS, type Keyword, type StringPart, type Token, type TokenType } from './token.js';

const KEYWORD_SET = new Set<string>(KEYWORDS);

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isIdentifierStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isIdentifierPart(ch: string): boolean {
  return isIdentifierStart(ch) || isDigit(ch);
}

/**
 * Converts Requestscript source text into a flat token stream.
 *
 * String literals are tokenized as a single 'string' token whose `parts`
 * hold the literal text chunks and the raw token streams of any `${...}`
 * interpolations (each interpolation stream is terminated by an 'eof' token
 * so it can be handed to a sub-parser).
 */
export class Lexer {
  private pos = 0;
  private line = 1;
  private column = 1;

  constructor(private readonly source: string) {}

  tokenize(): Token[] {
    const tokens: Token[] = [];
    for (;;) {
      const token = this.nextToken();
      tokens.push(token);
      if (token.type === 'eof') return tokens;
    }
  }

  private peek(offset = 0): string {
    // charAt returns '' past the end, which conveniently never matches any char test
    return this.source.charAt(this.pos + offset);
  }

  private advance(): string {
    const ch = this.source.charAt(this.pos);
    this.pos += 1;
    if (ch === '\n') {
      this.line += 1;
      this.column = 1;
    } else {
      this.column += 1;
    }
    return ch;
  }

  private skipWhitespaceAndComments(): void {
    for (;;) {
      const ch = this.peek();
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        this.advance();
      } else if (ch === '/' && this.peek(1) === '/') {
        while (this.peek() !== '' && this.peek() !== '\n') this.advance();
      } else {
        return;
      }
    }
  }

  private token(type: TokenType, value: string, line: number, column: number): Token {
    return { type, value, line, column };
  }

  private nextToken(): Token {
    this.skipWhitespaceAndComments();
    const line = this.line;
    const column = this.column;
    const ch = this.peek();

    if (ch === '') return this.token('eof', '', line, column);

    if (isDigit(ch)) return this.numberToken();
    if (isIdentifierStart(ch)) return this.identifierToken();
    if (ch === '"') return this.stringToken();

    // Two-character operators
    const two = ch + this.peek(1);
    if (two === '==' || two === '!=' || two === '<=' || two === '>=' || two === '&&' || two === '||') {
      this.advance();
      this.advance();
      return this.token(two, two, line, column);
    }

    if ('{}()[]:,.=<>!+-*/'.includes(ch)) {
      this.advance();
      return this.token(ch as TokenType, ch, line, column);
    }

    throw new LexError(`Unexpected character '${ch}'`, line, column);
  }

  private numberToken(): Token {
    const line = this.line;
    const column = this.column;
    let text = '';
    while (isDigit(this.peek())) text += this.advance();
    // A '.' is part of the number only when followed by a digit, so that
    // (future) member access on numbers is not misread.
    if (this.peek() === '.' && isDigit(this.peek(1))) {
      text += this.advance();
      while (isDigit(this.peek())) text += this.advance();
      return this.token('decimal', text, line, column);
    }
    return this.token('int', text, line, column);
  }

  private identifierToken(): Token {
    const line = this.line;
    const column = this.column;
    let text = '';
    while (isIdentifierPart(this.peek())) text += this.advance();
    const type: TokenType = KEYWORD_SET.has(text) ? (text as Keyword) : 'identifier';
    return this.token(type, text, line, column);
  }

  private stringToken(): Token {
    const line = this.line;
    const column = this.column;
    this.advance(); // opening quote

    const parts: StringPart[] = [];
    let text = '';
    const flushText = () => {
      if (text !== '') {
        parts.push({ type: 'text', value: text });
        text = '';
      }
    };

    for (;;) {
      const ch = this.peek();
      if (ch === '') throw new LexError('Unterminated string literal', line, column);
      if (ch === '\n') throw new LexError('Unterminated string literal (newline in string)', line, column);

      if (ch === '"') {
        this.advance();
        flushText();
        const token = this.token('string', '', line, column);
        token.parts = parts.length > 0 ? parts : [{ type: 'text', value: '' }];
        return token;
      }

      if (ch === '\\') {
        this.advance();
        const escaped = this.advance();
        switch (escaped) {
          case '"':
            text += '"';
            break;
          case '\\':
            text += '\\';
            break;
          case 'n':
            text += '\n';
            break;
          case 't':
            text += '\t';
            break;
          case 'r':
            text += '\r';
            break;
          case '$':
            text += '$';
            break;
          case '':
            throw new LexError('Unterminated string literal', line, column);
          default:
            throw new LexError(`Unknown escape sequence '\\${escaped}'`, this.line, this.column);
        }
        continue;
      }

      if (ch === '$' && this.peek(1) === '{') {
        this.advance(); // $
        this.advance(); // {
        flushText();
        parts.push({ type: 'expr', tokens: this.interpolationTokens() });
        continue;
      }

      text += this.advance();
    }
  }

  /**
   * Tokenizes the inside of a `${...}` interpolation up to its matching '}'.
   * Curly braces are tracked so object literals inside interpolations work.
   */
  private interpolationTokens(): Token[] {
    const startLine = this.line;
    const startColumn = this.column;
    const tokens: Token[] = [];
    let braceDepth = 0;

    for (;;) {
      this.skipWhitespaceAndComments();
      if (this.peek() === '') {
        throw new LexError('Unterminated string interpolation', startLine, startColumn);
      }
      if (this.peek() === '}' && braceDepth === 0) {
        this.advance();
        tokens.push({ type: 'eof', value: '', line: this.line, column: this.column });
        if (tokens.length === 1) {
          throw new LexError('Empty string interpolation', startLine, startColumn);
        }
        return tokens;
      }
      const token = this.nextToken();
      if (token.type === '{') braceDepth += 1;
      if (token.type === '}') braceDepth -= 1;
      tokens.push(token);
    }
  }
}

export function tokenize(source: string): Token[] {
  return new Lexer(source).tokenize();
}
