import type { ExprDto } from '../types';

/** Pretty-print an expression the way the profile editor edits it. */
export function formatExpr(expr: ExprDto, parentPrec = 0): string {
  switch (expr.op) {
    case 'const':
      return Number.isInteger(expr.value) ? String(expr.value) : String(expr.value);
    case 'param':
      return expr.id;
    case 'neg': {
      const inner = formatExpr(expr.value, 4);
      return `-${inner}`;
    }
    case 'add':
    case 'sub':
    case 'mul':
    case 'div': {
      const prec = expr.op === 'add' || expr.op === 'sub' ? 1 : 2;
      const op =
        expr.op === 'add' ? '+' : expr.op === 'sub' ? '-' : expr.op === 'mul' ? '*' : '/';
      const rhsPrec = expr.op === 'sub' || expr.op === 'div' ? prec + 1 : prec;
      const text = `${formatExpr(expr.lhs, prec)} ${op} ${formatExpr(expr.rhs, rhsPrec)}`;
      return prec < parentPrec ? `(${text})` : text;
    }
    case 'min':
      return `min(${formatExpr(expr.lhs)}, ${formatExpr(expr.rhs)})`;
    case 'max':
      return `max(${formatExpr(expr.lhs)}, ${formatExpr(expr.rhs)})`;
    default: {
      const exhaustive: never = expr;
      return exhaustive;
    }
  }
}

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'ident'; value: string }
  | { kind: 'op'; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      i += 1;
      continue;
    }
    if ('+-*/(),'.includes(ch)) {
      tokens.push({ kind: 'op', value: ch });
      i += 1;
      continue;
    }
    if (ch === '.' || (ch >= '0' && ch <= '9')) {
      const start = i;
      i += 1;
      while (i < input.length && (input[i] === '.' || (input[i] >= '0' && input[i] <= '9'))) i += 1;
      const raw = input.slice(start, i);
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`invalid number '${raw}'`);
      tokens.push({ kind: 'number', value });
      continue;
    }
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      const start = i;
      i += 1;
      while (
        i < input.length &&
        ((input[i] >= 'a' && input[i] <= 'z') ||
          (input[i] >= 'A' && input[i] <= 'Z') ||
          (input[i] >= '0' && input[i] <= '9') ||
          input[i] === '_')
      ) {
        i += 1;
      }
      tokens.push({ kind: 'ident', value: input.slice(start, i) });
      continue;
    }
    throw new Error(`unexpected '${ch}' in formula`);
  }
  return tokens;
}

class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): ExprDto {
    const expr = this.expr();
    if (this.i < this.tokens.length) throw new Error('unexpected trailing formula text');
    return expr;
  }

  private peek(): Token | undefined {
    return this.tokens[this.i];
  }

  private take(): Token {
    const token = this.tokens[this.i];
    if (!token) throw new Error('unexpected end of formula');
    this.i += 1;
    return token;
  }

  private eatOp(value: string): boolean {
    const token = this.peek();
    if (token?.kind === 'op' && token.value === value) {
      this.i += 1;
      return true;
    }
    return false;
  }

  private expr(): ExprDto {
    let left = this.term();
    while (true) {
      if (this.eatOp('+')) {
        left = { op: 'add', lhs: left, rhs: this.term() };
        continue;
      }
      if (this.eatOp('-')) {
        left = { op: 'sub', lhs: left, rhs: this.term() };
        continue;
      }
      break;
    }
    return left;
  }

  private term(): ExprDto {
    let left = this.factor();
    while (true) {
      if (this.eatOp('*')) {
        left = { op: 'mul', lhs: left, rhs: this.factor() };
        continue;
      }
      if (this.eatOp('/')) {
        left = { op: 'div', lhs: left, rhs: this.factor() };
        continue;
      }
      break;
    }
    return left;
  }

  private factor(): ExprDto {
    if (this.eatOp('-')) {
      return { op: 'neg', value: this.factor() };
    }
    if (this.eatOp('(')) {
      const inner = this.expr();
      if (!this.eatOp(')')) throw new Error('missing )');
      return inner;
    }
    const token = this.take();
    if (token.kind === 'number') return { op: 'const', value: token.value };
    if (token.kind === 'ident') {
      if (token.value === 'min' || token.value === 'max') {
        if (!this.eatOp('(')) throw new Error(`${token.value} needs (`);
        const lhs = this.expr();
        if (!this.eatOp(',')) throw new Error(`${token.value} needs two arguments`);
        const rhs = this.expr();
        if (!this.eatOp(')')) throw new Error('missing )');
        return { op: token.value, lhs, rhs };
      }
      return { op: 'param', id: token.value };
    }
    throw new Error('expected a number, name, or (');
  }
}

/** Parse a compact formula (`thickness / 2`) into the core `Expr` JSON. */
export function parseExpr(text: string): ExprDto {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('formula is empty');
  return new Parser(tokenize(trimmed)).parse();
}
