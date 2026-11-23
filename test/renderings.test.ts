import { describe, expect, it } from 'vitest';
import { builtinReads } from '../src/lang/builtins.js';
import { EntrypointError, ParameterError, ParseError, RuntimeError } from '../src/lang/errors.js';
import { entrypoints, walkStatements } from '../src/lang/functions.js';
import {
  createResourceResolver,
  interpret,
  interpretParsed,
  type InterpretOptions,
  type InterpretResult,
  type SessionStore,
  type SessionWrite,
  type StateScope,
  type StateStore,
  type StateWrite,
  type StoredState,
} from '../src/lang/interpreter.js';
import { maxTokens, TokenMeter } from '../src/lang/meter.js';
import { parseScript } from '../src/lang/parser.js';
import type { Resource } from '../src/lang/resource.js';
import type { ViewNode } from '../src/lang/views.js';
import { runBody } from './helpers.js';

/** A host's view of one rendering: shared state, one viewer's session, and the actions its last render returned. */
class Host {
  readonly state = new Map<string, StoredState>();
  readonly session = new Map<string, StoredState>();
  last: InterpretResult | undefined;
  private versions = 0;

  constructor(readonly source: string, readonly options: InterpretOptions = {}) {}

  private stores(): { state: StateStore; session: SessionStore } {
    const key = (name: string, scope: StateScope) => JSON.stringify([name, scope]);
    return {
      state: { get: async (name, scope) => this.state.get(key(name, scope)) },
      session: { get: async (name) => this.session.get(name) },
    };
  }

  save(state: StateWrite[], session: SessionWrite[]): void {
    for (const write of state) this.state.set(JSON.stringify([write.name, write.scope]), { value: write.value, type: write.type, version: ++this.versions });
    for (const write of session) this.session.set(write.name, { value: write.value, type: write.type, version: ++this.versions });
  }

  async render(): Promise<ViewNode> {
    this.last = await interpret(this.source, { ...this.options, ...this.stores(), function: 'render' });
    return this.last.view!;
  }

  /** Runs the action a component's argument names in the last render, saves what it wrote, and renders again. */
  async act(path: number[], arg = 'action', args?: unknown[]): Promise<ViewNode> {
    const id = nodeAt(this.last!.view!, path).actions[arg]!;
    const handle = this.last!.actions!.find((candidate) => candidate.id === id)!;
    const result = await interpret(this.source, {
      ...this.options,
      ...this.stores(),
      action: { lambda: handle.lambda, captures: handle.captures, ...(args ? { args } : {}) },
    });
    this.save(result.state, result.session);
    return this.render();
  }
}

function nodeAt(root: ViewNode, path: number[]): ViewNode {
  return path.reduce((node, i) => node.children[i]!, root);
}

/** The tree without its empty fields, so expectations read like the UI. */
function shape(node: ViewNode): unknown {
  return {
    type: node.type,
    ...(Object.keys(node.props).length ? { props: node.props } : {}),
    ...(Object.keys(node.modifiers).length ? { modifiers: node.modifiers } : {}),
    ...(node.children.length ? { children: node.children.map(shape) } : {}),
  };
}

const countUp = `rendering com.example.CountUp@1 {
    var state("count") count = 0

    fn increaseCount() {
        count += 1
    }

    pub fn render() {
        Column {
            Text(str: "Count: \${count}")
                .color(of: "blue")

            Button(label: "Up", action: () => { increaseCount() })
        }
    }
}`;

describe('renderings: parsing', () => {
  it('parses the declaration, its entrypoint and its lambdas', () => {
    const script = parseScript(countUp);
    expect(script.declaration).toEqual({ kind: 'rendering', path: ['com', 'example'], name: 'CountUp', version: '1' });
    expect(entrypoints(script).map((fn) => fn.name)).toEqual(['render']);
    expect(script.lambdas).toHaveLength(1);
    expect(script.lambdas![0]).toMatchObject({ index: 0, parameters: [], names: [] });
  });

  it('still parses names called rendering, protected and Text outside renderings', () => {
    const script = parseScript('request R {\n  var rendering = 1\n  var protected = 2\n  var Text = 3\n  return rendering + protected + Text\n}');
    expect(script.body).toHaveLength(4);
  });

  it('parses a lambda that takes the text of a TextField, whatever it names it', () => {
    const script = parseScript('rendering a.B {\n  protected var name = ""\n  pub fn render() {\n    TextField(placeholder: "Name", action: (input: string) => { name = input })\n  }\n}');
    expect(script.lambdas![0]!.parameters).toEqual([{ name: 'input', type: { kind: 'string' } }]);
    expect(script.lambdas![0]!.names).toEqual(['name']);
  });

  it('walks the statements in children and lambdas', () => {
    const kinds: string[] = [];
    walkStatements(parseScript(countUp), (statement) => kinds.push(statement.kind));
    expect(kinds).toEqual(['varDecl', 'assign', 'exprStmt', 'exprStmt', 'exprStmt', 'exprStmt']);
  });

  it.each([
    ['no render', 'rendering a.B {\n  fn helper() {}\n}', "needs its entrypoint: 'pub fn render()"],
    ['a render with parameters', 'rendering a.B {\n  pub fn render(x: string) {}\n}', 'takes no parameters'],
    ['a render with a return type', 'rendering a.B {\n  pub fn render(): string {\n    return ""\n  }\n}', 'has no return type'],
    ['another pub fn', 'rendering a.B {\n  pub fn render() {}\n  pub fn other() {}\n}', "function 'other' can't be pub"],
    ['a payable render', 'rendering a.B {\n  pub payable fn render() {}\n}', "isn't payable"],
    ['a plain top-level var', 'rendering a.B {\n  var loggedIn = false\n  pub fn render() {}\n}', "'var state', shared by every viewer, or 'protected var'"],
    ['a protected var in a function', 'rendering a.B {\n  pub fn render() {\n    protected var x = 1\n  }\n}', "declared at the rendering's top level"],
    ['a protected var in a contract', 'contract a.B {\n  protected var x = 1\n  pub fn run() {}\n}', 'only be declared in a rendering'],
    ['a protected state var', 'rendering a.B {\n  protected var state x = 1\n  pub fn render() {}\n}', "either 'var state' or 'protected var'"],
    ['emit', 'rendering a.B {\n  pub fn render() {\n    emit a.E(x: 1)\n  }\n}', "can't emit events"],
    ['attached money', 'rendering a.B {\n  const r: a.R@1\n  fn go() {\n    r.f{amount: 1, from: "o"}()\n  }\n  pub fn render() {\n    Button(label: "Go", action: () => { go() })\n  }\n}', "can't attach money"],
    ['a component named as a var', 'rendering a.B {\n  pub fn render() {\n    var Text = 1\n  }\n}', "'Text' is a component"],
    ['a component named as a function', 'rendering a.B {\n  fn Row() {}\n  pub fn render() {}\n}', "'Row' is a component"],
    ['an unknown argument', 'rendering a.B {\n  pub fn render() {\n    Text(string: "x")\n  }\n}', "Text has no argument 'string': it takes 'str'"],
    ['a missing argument', 'rendering a.B {\n  pub fn render() {\n    Button(label: "x")\n  }\n}', "Button needs argument 'action'"],
    ['children on a component without them', 'rendering a.B {\n  pub fn render() {\n    Text(str: "x") {\n    }\n  }\n}', 'Text has no children'],
    ['an action that is not a lambda', 'rendering a.B {\n  fn go() {}\n  pub fn render() {\n    Button(label: "x", action: go())\n  }\n}', "Argument 'action' of Button is an action: write '() => { ... }'"],
    ['a lambda with the wrong parameters', 'rendering a.B {\n  pub fn render() {\n    Button(label: "x", action: (n: int32) => {})\n  }\n}', 'The action of Button is passed nothing'],
    ['a lambda that returns a value', 'rendering a.B {\n  pub fn render() {\n    Button(label: "x", action: () => {\n      return 1\n    })\n  }\n}', 'An action returns nothing'],
    ['an unknown modifier', 'rendering a.B {\n  pub fn render() {\n    Text(str: "x").glow(of: "red")\n  }\n}', "Unknown modifier 'glow'"],
    ['a modifier the component lacks', 'rendering a.B {\n  pub fn render() {\n    Text(str: "x").enabled(is: false)\n  }\n}', "Text has no modifier 'enabled'"],
    ['a modifier with the wrong argument', 'rendering a.B {\n  pub fn render() {\n    Text(str: "x").color(is: "red")\n  }\n}', "takes one argument, 'of'"],
    ['calling render', 'rendering a.B {\n  pub fn render() {\n    Button(label: "x", action: () => { render() })\n  }\n}', "it can't be called"],
  ])('refuses %s', (_name, source, message) => {
    expect(() => parseScript(source)).toThrow(ParseError);
    expect(() => parseScript(source)).toThrow(message);
  });

  it('refuses a render that changes state, directly or through a function', () => {
    expect(() => parseScript('rendering a.B {\n  var state n = 0\n  pub fn render() {\n    n += 1\n  }\n}')).toThrow("'render' can't change 'n'");
    expect(() => parseScript('rendering a.B {\n  protected var p = [1]\n  fn bump() {\n    p[0] = 2\n  }\n  pub fn render() {\n    bump()\n  }\n}'))
      .toThrow("Function 'bump', which 'render' calls, can't change 'p'");
  });

  it('refuses a render that calls a resource, but not an action that does', () => {
    const calling = (where: string) => `rendering a.B {\n  const r: a.R@1\n  fn go() {\n    r.f()\n  }\n  pub fn render() {\n    ${where}\n  }\n}`;
    expect(() => parseScript(calling('go()'))).toThrow("Function 'go', which 'render' calls, can't call resources");
    expect(() => parseScript(calling('Button(label: "Go", action: () => { go() })'))).not.toThrow();
  });

  it('lets a render change its own locals', () => {
    expect(() => parseScript('rendering a.B {\n  pub fn render() {\n    var label = "a"\n    label += "b"\n    Text(str: label)\n  }\n}')).not.toThrow();
  });
});

describe('renderings: rendering', () => {
  it('returns the UI tree, with modifiers and an action handle', async () => {
    const host = new Host(countUp);
    const view = await host.render();
    expect(shape(view)).toEqual({
      type: 'Root',
      children: [{
        type: 'Column',
        children: [
          { type: 'Text', props: { str: 'Count: 0' }, modifiers: { color: 'blue' } },
          { type: 'Button', props: { label: 'Up' } },
        ],
      }],
    });
    expect(nodeAt(view, [0, 1]).actions).toEqual({ action: '0' });
    expect(host.last!.actions).toEqual([{ id: '0', lambda: 0, captures: {} }]);
    expect(host.last!.state).toEqual([]);
  });

  it('runs an action, which writes state, and renders it', async () => {
    const host = new Host(countUp);
    await host.render();
    await host.act([0, 1]);
    const view = await host.act([0, 1]);
    expect(nodeAt(view, [0, 0]).props).toEqual({ str: 'Count: 2' });
  });

  it('shares state between viewers and keeps protected variables per session', async () => {
    const source = `rendering a.Notes {
  var state("all") total = 0
  protected var mine = 0
  pub fn render() {
    Text(str: "\${total} \${mine}")
    Button(label: "Add", action: () => {
      total += 1
      mine += 1
    })
  }
}`;
    const alice = new Host(source);
    await alice.render();
    await alice.act([1]);
    const bob = new Host(source);
    for (const [key, value] of alice.state) bob.state.set(key, value);
    await bob.render();
    expect(nodeAt(await bob.act([1]), [0]).props).toEqual({ str: '2 1' });
    expect(nodeAt(await alice.render(), [0]).props).toEqual({ str: '1 1' });
  });

  it('keeps the text of a TextField in a protected variable', async () => {
    const source = `rendering a.Login {
  protected var username = ""
  pub fn render() {
    TextField(placeholder: "Enter Username", action: (usernameInput: string) => { username = usernameInput })
    Text(str: "Hello \${username}")
  }
}`;
    const host = new Host(source);
    await host.render();
    const view = await host.act([0], 'action', ['ada']);
    expect(nodeAt(view, [1]).props).toEqual({ str: 'Hello ada' });
    expect(host.session.get('username')!.value).toBe('ada');
  });

  it('builds children from if statements, locals and the functions render calls', async () => {
    const source = `rendering a.List {
  protected var open = true
  fn item(label: string) {
    Row {
      Text(str: label)
    }
  }
  pub fn render() {
    Page
      .title(str: "List")
    Column {
      if (open) {
        item(label: "one")
      } else {
        Text(str: "closed")
      }
      const two = "two"
      item(label: two)
    }
  }
}`;
    expect(shape(await new Host(source).render())).toEqual({
      type: 'Root',
      children: [
        { type: 'Page', modifiers: { title: 'List' } },
        {
          type: 'Column',
          children: [
            { type: 'Row', children: [{ type: 'Text', props: { str: 'one' } }] },
            { type: 'Row', children: [{ type: 'Text', props: { str: 'two' } }] },
          ],
        },
      ],
    });
  });

  it('captures the render\'s locals an action reads, as they were', async () => {
    const source = `rendering a.Pick {
  protected var picked = "none"
  fn choice(label: string) {
    Button(label: label, action: () => { picked = label })
  }
  pub fn render() {
    Text(str: picked)
    choice(label: "red")
    choice(label: "blue")
  }
}`;
    const host = new Host(source);
    await host.render();
    expect(host.last!.actions).toEqual([
      { id: '0', lambda: 0, captures: { label: 'red' } },
      { id: '1', lambda: 0, captures: { label: 'blue' } },
    ]);
    expect(nodeAt(await host.act([2]), [0]).props).toEqual({ str: 'blue' });
  });

  it('reads the host\'s built-ins, such as signIn, also as a state scope', async () => {
    const source = `rendering a.Hello {
  var state(signIn.id) count = 0
  pub fn render() {
    Text(str: "Hello \${signIn.name}: \${count} (\${queryParams.title})")
  }
}`;
    const host = new Host(source, { builtins: { signIn: { id: 'u1', name: 'Ada' }, queryParams: {} } });
    expect(nodeAt(await host.render(), [0]).props).toEqual({ str: 'Hello Ada: 0 (null)' });
  });

  it('refuses modifier values it can\'t draw, and unsafe urls', async () => {
    const tree = (body: string) => new Host(`rendering a.B {\n  pub fn render() {\n    ${body}\n  }\n}`).render();
    await expect(tree('Text(str: "x").color(of: "red; display: none")')).rejects.toThrow("Modifier 'color' must be a color name or a hex color");
    await expect(tree('Text(str: "x").width(of: "100")')).rejects.toThrow("Modifier 'width' must be a size");
    await expect(tree('Text(str: "x").fontSize(size: 900)')).rejects.toThrow("Modifier 'fontSize' must be from 1 to 200");
    await expect(tree('Link(to: "javascript:alert(1)", text: "x")')).rejects.toThrow("Argument 'to' of Link must be an http or https url");
    await expect(tree('Image(str: "https://example.com/a.png").border(of: "1px #e5e7eb").padding(of: "50%")')).resolves.toBeDefined();
    await expect(tree('Text(str: 5)')).rejects.toThrow(RuntimeError);
  });

  it('leaves a modifier unset when its value is null', async () => {
    const host = new Host('rendering a.B {\n  pub fn render() {\n    Text(str: "x").color(of: "red").color(of: queryParams.color)\n  }\n}', { builtins: { queryParams: {} } });
    expect(nodeAt(await host.render(), [0]).modifiers).toEqual({});
  });

  it('writes nothing in a render, even when it changes a list it read', async () => {
    const source = 'rendering a.B {\n  var state items = [1]\n  pub fn render() {\n    var copy = items\n    copy[0] = 2\n    Text(str: "${items}")\n  }\n}';
    const host = new Host(source);
    await host.render();
    expect(host.last!.state).toEqual([]);
    expect(host.last!.session).toEqual([]);
  });

  it('refuses components outside a render, and views kept in variables', async () => {
    const host = new Host('rendering a.B {\n  protected var n = 0\n  fn label() {\n    Text(str: "x")\n  }\n  pub fn render() {\n    Button(label: "x", action: () => { label() })\n  }\n}');
    await host.render();
    await expect(host.act([0])).rejects.toThrow('Components can only be built while rendering, not in an action');
    await expect(new Host('rendering a.B {\n  pub fn render() {\n    var t = Text(str: "x")\n  }\n}').render()).rejects.toThrow('not kept in a variable');
  });

  it('runs only render or an action', async () => {
    await expect(interpret(countUp, { function: 'increaseCount', state: { get: async () => undefined } })).rejects.toThrow(EntrypointError);
    await expect(interpret(countUp, { action: { lambda: 7 }, state: { get: async () => undefined } })).rejects.toThrow('has no action 7');
    await expect(interpret('contract a.B {\n  pub fn run() {}\n}', { action: { lambda: 0 } })).rejects.toThrow('Only a rendering has actions');
    await expect(interpret(countUp, { function: 'render', parameters: { x: 1 } })).rejects.toThrow(ParameterError);
  });

  it('refuses captures the action doesn\'t read, and arguments it isn\'t passed', async () => {
    const source = 'rendering a.B {\n  protected var t = ""\n  pub fn render() {\n    TextField(placeholder: "x", action: (text: string) => { t = text })\n  }\n}';
    const session = { get: async () => undefined };
    await expect(interpret(source, { session, action: { lambda: 0, captures: { other: 1 }, args: ['a'] } })).rejects.toThrow("doesn't read 'other'");
    await expect(interpret(source, { session, action: { lambda: 0, args: [] } })).rejects.toThrow('takes 1 argument, not 0');
    await expect(interpret(source, { session, action: { lambda: 0, args: [5] } })).rejects.toThrow(ParameterError);
  });

  it('needs a session store for protected variables', async () => {
    await expect(interpret('rendering a.B {\n  protected var n = 0\n  pub fn render() {}\n}', { function: 'render' }))
      .rejects.toThrow("Protected variable 'n' needs a host that keeps sessions");
  });
});

describe('renderings: actions that call resources', () => {
  const auth: Resource = {
    path: 'com.example',
    name: 'Auth',
    version: '1',
    metadata: {},
    functions: [{
      name: 'checkLogin',
      parameters: [{ name: 'username', type: 'string' }],
      returnType: 'object',
      exec: async (parameters) => ({ loggedIn: parameters[0]!.value === 'ada' }),
    }],
  };
  const login = `rendering com.example.Login@1 {
  const auth: com.example.Auth@1
  protected var username = "ada"
  protected var loading = false
  protected var loggedIn = false

  fn checkLogin() {
    loading = true
    const result = auth.checkLogin(username: username)
    if (result.value != null) {
      loggedIn = result.value.loggedIn
    }
    loading = false
  }

  pub fn render() {
    Button(label: "Log in", action: () => { checkLogin() })
      .enabled(is: !loading)
  }
}`;

  it('tells the host what changed before each call, so it can show a loading state', async () => {
    const snapshots: unknown[] = [];
    const result = await interpret(login, {
      resourceResolver: createResourceResolver([auth]),
      session: { get: async () => undefined },
      action: { lambda: 0 },
      onBeforeInvoke: (snapshot) => { snapshots.push(Object.fromEntries(snapshot.session.map((write) => [write.name, write.value]))); },
    });
    expect(snapshots).toEqual([{ username: 'ada', loading: true, loggedIn: false }]);
    expect(Object.fromEntries(result.session.map((write) => [write.name, write.value]))).toEqual({ username: 'ada', loading: false, loggedIn: true });
  });

  it('doesn\'t call the hook when nothing changed', async () => {
    const calls: unknown[] = [];
    const source = 'rendering a.B {\n  const auth: com.example.Auth@1\n  fn go() {\n    auth.checkLogin(username: "x")\n  }\n  pub fn render() {\n    Button(label: "Go", action: () => { go() })\n  }\n}';
    await interpret(source, { resourceResolver: createResourceResolver([auth]), action: { lambda: 0 }, onBeforeInvoke: (snapshot) => { calls.push(snapshot); } });
    expect(calls).toEqual([]);
  });
});

describe('renderings: tokens', () => {
  it('bounds a render without its actions, and an action by its lambda', async () => {
    const script = parseScript(countUp);
    const render = new TokenMeter();
    await interpretParsed(script, { function: 'render', state: { get: async () => undefined }, meter: render });
    expect(render.tokens).toBeGreaterThan(0);
    expect(maxTokens(script, 'render')).toBe(render.tokens);
    expect(maxTokens(script)).toBe(render.tokens);

    const action = new TokenMeter();
    await interpretParsed(script, { action: { lambda: 0 }, state: { get: async () => undefined }, meter: action });
    expect(maxTokens(script, { action: 0 })).toBe(action.tokens);
    expect(() => maxTokens(script, { action: 1 })).toThrow(EntrypointError);
  });
});

describe('renderings: builtinReads', () => {
  it('finds the fields a rendering reads, in render, functions and actions', () => {
    const script = parseScript(`rendering a.B {
  var state(signIn.id) n = 0
  fn greet() {
    Text(str: signIn.name)
  }
  pub fn render() {
    greet()
    Button(label: "x", action: () => {
      if (signIn.email == "") {
        n = 1
      }
    })
  }
}`);
    expect(builtinReads(script, 'signIn')).toEqual({ fields: ['id', 'name', 'email'], whole: false });
    expect(builtinReads(script, 'headers')).toEqual({ fields: [], whole: false });
  });

  it('reports a built-in used whole', () => {
    const script = parseScript('rendering a.B {\n  pub fn render() {\n    Text(str: "${signIn}")\n  }\n}');
    expect(builtinReads(script, 'signIn')).toEqual({ fields: [], whole: true });
  });
});

describe('compound assignment', () => {
  it('adds to and takes from variables, properties and list elements', async () => {
    await expect(runBody('var n = 1\nn += 2\nn -= 1\nvar s = "a"\ns += "b"\nvar o = { x: 1 }\no.x += 5\nvar l = [1, 2]\nl[1] -= 2\nreturn [n, s, o.x, l]'))
      .resolves.toEqual([2, 'ab', 6, [1, 0]]);
  });

  it('checks the result against the variable\'s type', async () => {
    await expect(runBody('var n: int32 = 2147483647\nn += 1')).rejects.toThrow('int32 overflow');
    await expect(runBody('var n = 1\nn += true')).rejects.toThrow(RuntimeError);
  });

  it('refuses a const', async () => {
    await expect(runBody('const n = 1\nn += 1')).rejects.toThrow("because it is a const");
  });
});
