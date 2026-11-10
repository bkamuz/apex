/**
 * Genus formulas in the browser: the same grammar as the core's
 * (`genus_body.rs` Parser) so the editor can check a formula while it is
 * typed and show computed values per species without a round trip.
 *
 *   or   := and (('or' | '||') and)*
 *   and  := cmp (('and' | '&&') cmp)*
 *   cmp  := sum (('<=' | '>=' | '==' | '!=' | '<' | '>' | '=') sum)?
 *   sum  := product (('+' | '-') product)*
 *   prod := unary (('*' | '/') unary)*
 *   unary:= '-' unary | '!' unary | 'not' unary | atom
 *   atom := '(' or ')' | number | true | false | min(a, b) | max(a, b) | if(c, a, b) | name
 */

export type Ast =
  | { op: 'num'; value: number }
  | { op: 'param'; id: string }
  | { op: 'neg' | 'not'; value: Ast }
  | { op: '+' | '-' | '*' | '/' | 'and' | 'or' | 'min' | 'max'; lhs: Ast; rhs: Ast }
  | { op: 'cmp'; cmp: '<' | '<=' | '>' | '>=' | '==' | '!='; lhs: Ast; rhs: Ast }
  | { op: 'if'; cond: Ast; then: Ast; otherwise: Ast };

/** Why a formula is not valid; `code` picks the message (genusEditor.formula.err.*). */
export interface FormulaError {
  code: 'empty' | 'unexpected' | 'end' | 'paren' | 'args' | 'number' | 'unknown' | 'text' | 'cycle';
  /** Character offset the problem was found at (syntax errors). */
  pos?: number;
  /** Message params: the offending text / name / count. */
  detail?: Record<string, string | number>;
}

export type ParseResult = { ok: true; ast: Ast; refs: string[] } | { ok: false; error: FormulaError };

class Fail extends Error {
  readonly err: FormulaError;
  constructor(err: FormulaError) {
    super(err.code);
    this.err = err;
  }
}

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
const isAlpha = (c: string | undefined) => c !== undefined && /[A-Za-z_]/.test(c);
const isWord = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_.]/.test(c);

class Parser {
  i = 0;
  private readonly s: string;
  constructor(s: string) {
    this.s = s;
  }
  ws() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i += 1;
  }
  eatStr(tok: string): boolean {
    this.ws();
    if (this.s.startsWith(tok, this.i)) {
      this.i += tok.length;
      return true;
    }
    return false;
  }
  eatKw(kw: string): boolean {
    this.ws();
    if (this.s.startsWith(kw, this.i) && !isWord(this.s[this.i + kw.length])) {
      this.i += kw.length;
      return true;
    }
    return false;
  }
  all(): Ast {
    this.ws();
    if (this.i >= this.s.length) throw new Fail({ code: 'empty', pos: 0 });
    const e = this.or();
    this.ws();
    if (this.i !== this.s.length) throw new Fail({ code: 'unexpected', pos: this.i, detail: { text: this.s[this.i] } });
    return e;
  }
  or(): Ast {
    let e = this.and();
    while (this.eatKw('or') || this.eatStr('||')) e = { op: 'or', lhs: e, rhs: this.and() };
    return e;
  }
  and(): Ast {
    let e = this.cmp();
    while (this.eatKw('and') || this.eatStr('&&')) e = { op: 'and', lhs: e, rhs: this.cmp() };
    return e;
  }
  cmp(): Ast {
    const e = this.sum();
    const ops: [string, '<' | '<=' | '>' | '>=' | '==' | '!='][] = [
      ['<=', '<='],
      ['>=', '>='],
      ['==', '=='],
      ['!=', '!='],
      ['<', '<'],
      ['>', '>'],
      ['=', '=='],
    ];
    for (const [tok, cmp] of ops) {
      if (this.eatStr(tok)) return { op: 'cmp', cmp, lhs: e, rhs: this.sum() };
    }
    return e;
  }
  sum(): Ast {
    let e = this.product();
    for (;;) {
      if (this.eatStr('+')) e = { op: '+', lhs: e, rhs: this.product() };
      else if (this.eatStr('-')) e = { op: '-', lhs: e, rhs: this.product() };
      else return e;
    }
  }
  product(): Ast {
    let e = this.unary();
    for (;;) {
      if (this.eatStr('*')) e = { op: '*', lhs: e, rhs: this.unary() };
      else if (this.eatStr('/')) e = { op: '/', lhs: e, rhs: this.unary() };
      else return e;
    }
  }
  unary(): Ast {
    if (this.eatStr('-')) return { op: 'neg', value: this.unary() };
    this.ws();
    if (this.s[this.i] === '!' && this.s[this.i + 1] !== '=') {
      this.i += 1;
      return { op: 'not', value: this.unary() };
    }
    if (this.eatKw('not')) return { op: 'not', value: this.unary() };
    return this.atom();
  }
  args(name: string, n: number): Ast[] {
    const out = [this.or()];
    while (out.length < n) {
      if (!this.eatStr(',')) throw new Fail({ code: 'args', pos: this.i, detail: { name, n } });
      out.push(this.or());
    }
    if (!this.eatStr(')')) throw new Fail({ code: 'args', pos: this.i, detail: { name, n } });
    return out;
  }
  atom(): Ast {
    this.ws();
    if (this.eatStr('(')) {
      const e = this.or();
      if (!this.eatStr(')')) throw new Fail({ code: 'paren', pos: this.i });
      return e;
    }
    const start = this.i;
    const c = this.s[this.i];
    if (c === undefined) throw new Fail({ code: 'end', pos: this.i });
    if (isDigit(c) || c === '.') {
      while (this.i < this.s.length && (isDigit(this.s[this.i]) || this.s[this.i] === '.' || this.s[this.i] === 'e')) this.i += 1;
      const text = this.s.slice(start, this.i);
      const value = Number(text);
      if (!Number.isFinite(value) || text === '.') throw new Fail({ code: 'number', pos: start, detail: { text } });
      return { op: 'num', value };
    }
    if (isAlpha(c)) {
      while (this.i < this.s.length && isWord(this.s[this.i])) this.i += 1;
      const name = this.s.slice(start, this.i);
      if (name === 'true') return { op: 'num', value: 1 };
      if (name === 'false') return { op: 'num', value: 0 };
      if ((name === 'min' || name === 'max' || name === 'if') && this.eatStr('(')) {
        const a = this.args(name, name === 'if' ? 3 : 2);
        if (name === 'if') return { op: 'if', cond: a[0], then: a[1], otherwise: a[2] };
        return { op: name, lhs: a[0], rhs: a[1] };
      }
      return { op: 'param', id: name };
    }
    throw new Fail({ code: 'unexpected', pos: start, detail: { text: c } });
  }
}

function collect(ast: Ast, out: string[]) {
  switch (ast.op) {
    case 'num':
      return;
    case 'param':
      if (!out.includes(ast.id)) out.push(ast.id);
      return;
    case 'neg':
    case 'not':
      collect(ast.value, out);
      return;
    case 'if':
      collect(ast.cond, out);
      collect(ast.then, out);
      collect(ast.otherwise, out);
      return;
    default:
      collect(ast.lhs, out);
      collect(ast.rhs, out);
  }
}

export function parseFormula(src: string): ParseResult {
  try {
    const ast = new Parser(src).all();
    const refs: string[] = [];
    collect(ast, refs);
    return { ok: true, ast, refs };
  } catch (err) {
    if (err instanceof Fail) return { ok: false, error: err.err };
    throw err;
  }
}

/** Names a formula text reads (empty when it does not parse). */
export function formulaRefs(src: string): string[] {
  const r = parseFormula(src);
  return r.ok ? r.refs : [];
}

const truthy = (v: number) => v !== 0 && !Number.isNaN(v);

/** Evaluate; unknown names give NaN (the caller validates refs first). */
export function evalAst(ast: Ast, values: Record<string, unknown>): number {
  const ev = (a: Ast): number => {
    switch (a.op) {
      case 'num':
        return a.value;
      case 'param': {
        const v = values[a.id];
        return typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : NaN;
      }
      case 'neg':
        return -ev(a.value);
      case 'not':
        return truthy(ev(a.value)) ? 0 : 1;
      case '+':
        return ev(a.lhs) + ev(a.rhs);
      case '-':
        return ev(a.lhs) - ev(a.rhs);
      case '*':
        return ev(a.lhs) * ev(a.rhs);
      case '/':
        return ev(a.lhs) / ev(a.rhs);
      case 'min':
        return Math.min(ev(a.lhs), ev(a.rhs));
      case 'max':
        return Math.max(ev(a.lhs), ev(a.rhs));
      case 'and':
        return truthy(ev(a.lhs)) && truthy(ev(a.rhs)) ? 1 : 0;
      case 'or':
        return truthy(ev(a.lhs)) || truthy(ev(a.rhs)) ? 1 : 0;
      case 'if':
        return truthy(ev(a.cond)) ? ev(a.then) : ev(a.otherwise);
      case 'cmp': {
        const l = ev(a.lhs);
        const r = ev(a.rhs);
        switch (a.cmp) {
          case '<':
            return l < r ? 1 : 0;
          case '<=':
            return l <= r ? 1 : 0;
          case '>':
            return l > r ? 1 : 0;
          case '>=':
            return l >= r ? 1 : 0;
          case '==':
            return Math.abs(l - r) < 1e-9 ? 1 : 0;
          case '!=':
            return Math.abs(l - r) >= 1e-9 ? 1 : 0;
        }
      }
    }
  };
  return ev(ast);
}

const NOT_FORMULA = new Set(['id', 'item', 'shape', 'genus', 'species', 'ref', 'normal', 'show', 'part', 'axis']);

/** Identifiers read by any formula text inside a JSON value (body, refs, dims). */
export function namesInJson(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const id of formulaRefs(value)) out.add(id);
  } else if (Array.isArray(value)) {
    for (const v of value) namesInJson(v, out);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      // Ids, kinds and genus / species names are not formulas.
      if (NOT_FORMULA.has(k)) continue;
      namesInJson(v, out);
    }
  }
  return out;
}
