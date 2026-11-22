/**
 * The components and modifiers renderings build their UI from (SIP-2). This is the one place their names,
 * arguments and values are defined: the parser checks scripts against it, the interpreter checks values, and
 * hosts draw the `ViewNode` trees a render returns.
 */

/** A value a component or modifier argument takes. `action` is a lambda, with the parameters it must declare. */
export type ViewArgumentType =
  | { kind: 'string' }
  | { kind: 'int32' }
  | { kind: 'boolean' }
  | { kind: 'action'; parameters: { name: string; type: 'string' }[] };

export interface ComponentSpec {
  /** Its arguments, all required, in the order they're documented. */
  args: { name: string; type: ViewArgumentType; check?: (value: unknown) => string | undefined }[];
  /** Whether it takes a trailing `{ ... }` block of children. */
  children: boolean;
}

export interface ModifierSpec {
  /** Its one argument. */
  arg: string;
  type: ViewArgumentType;
  /** The components it applies to. */
  components: readonly string[];
  /** Why a value is refused, or undefined when it is accepted. */
  check?: (value: unknown) => string | undefined;
}

const STRING = { kind: 'string' } as const;
const INT = { kind: 'int32' } as const;
const BOOLEAN = { kind: 'boolean' } as const;

const URL_PATTERN = /^https?:\/\/[^\s]+$/i;
const COLOR_PATTERN = /^(?:[a-z]+|#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8}))$/i;
const SIZE_PATTERN = /^(?:0|\d+(?:\.\d+)?(?:px|%|rem|em))$/;
const MAX_FONT_SIZE = 200;

const url = (value: unknown) => (typeof value === 'string' && URL_PATTERN.test(value) ? undefined : 'must be an http or https url');
const color = (value: unknown) => (typeof value === 'string' && COLOR_PATTERN.test(value) ? undefined : 'must be a color name or a hex color such as #1f2937');
const size = (value: unknown) => (typeof value === 'string' && SIZE_PATTERN.test(value) ? undefined : 'must be a size: a number with px, %, rem or em, such as 12px');
const border = (value: unknown) => {
  if (typeof value !== 'string') return 'must be a size, optionally followed by a color, such as 1px or 1px #e5e7eb';
  const [width, borderColor, ...rest] = value.trim().split(/\s+/);
  if (rest.length > 0 || size(width) !== undefined || (borderColor !== undefined && color(borderColor) !== undefined)) {
    return 'must be a size, optionally followed by a color, such as 1px or 1px #e5e7eb';
  }
  return undefined;
};
const fontSize = (value: unknown) => (typeof value === 'number' && value >= 1 && value <= MAX_FONT_SIZE ? undefined : `must be from 1 to ${MAX_FONT_SIZE}`);

export const COMPONENTS: Readonly<Record<string, ComponentSpec>> = {
  Page: { args: [], children: false },
  Column: { args: [], children: true },
  Row: { args: [], children: true },
  Text: { args: [{ name: 'str', type: STRING }], children: false },
  Button: { args: [{ name: 'label', type: STRING }, { name: 'action', type: { kind: 'action', parameters: [] } }], children: false },
  TextField: {
    args: [{ name: 'placeholder', type: STRING }, { name: 'action', type: { kind: 'action', parameters: [{ name: 'text', type: 'string' }] } }],
    children: false,
  },
  Image: { args: [{ name: 'str', type: STRING, check: url }], children: false },
  Link: { args: [{ name: 'to', type: STRING, check: url }, { name: 'text', type: STRING }], children: false },
};

const VISIBLE = ['Column', 'Row', 'Text', 'Button', 'TextField', 'Image', 'Link'] as const;

export const MODIFIERS: Readonly<Record<string, ModifierSpec>> = {
  title: { arg: 'str', type: STRING, components: ['Page'] },
  color: { arg: 'of', type: STRING, components: ['Text', 'Button', 'Link'], check: color },
  backgroundColor: { arg: 'of', type: STRING, components: VISIBLE, check: color },
  fontSize: { arg: 'size', type: INT, components: ['Text', 'Button', 'Link', 'TextField'], check: fontSize },
  width: { arg: 'of', type: STRING, components: VISIBLE, check: size },
  height: { arg: 'of', type: STRING, components: VISIBLE, check: size },
  padding: { arg: 'of', type: STRING, components: VISIBLE, check: size },
  border: { arg: 'of', type: STRING, components: VISIBLE, check: border },
  enabled: { arg: 'is', type: BOOLEAN, components: ['Button', 'TextField'] },
};

/** Whether `name` is a component, which a rendering can't use as the name of anything else. */
export function isComponent(name: string): boolean {
  return Object.hasOwn(COMPONENTS, name);
}

/**
 * A node of the UI tree a render returns, as JSON. `props` are its component's arguments, `modifiers` the
 * modifiers applied to it (the last of each wins), and `actions` maps each action argument to the id of an
 * `ActionHandle` the render returned. A render's tree is rooted at a node of type `Root`.
 */
export interface ViewNode {
  type: string;
  props: Record<string, unknown>;
  modifiers: Record<string, unknown>;
  actions: Record<string, string>;
  children: ViewNode[];
}

/** The type of a render's root node, which holds what `render()` writes at its top level. */
export const ROOT_VIEW = 'Root';
