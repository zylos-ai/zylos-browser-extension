import { z } from 'zod';
import { actionParams } from './commands';
import { REMOTE_VERSION } from './remote';
import instructions from '../agent/browser-guide.md?raw';

// The same schemas validate RPC inputs and generate the Agent's live reference.
export const remoteParams = {
  ...actionParams,
  info: z.object({}).strict(),
  start: z.object({ url: z.string().url().max(4000) }).strict(),
  finalize: z.object({ keep: z.array(z.number().int().nonnegative()).max(8).default([]) }).strict(),
  describe: z
    .object({
      method: z.string().min(1).max(128).optional(),
      methods: z.array(z.string().min(1).max(128)).min(1).max(8).optional(),
    })
    .strict(),
} as const;
export type RemoteMethod = keyof typeof remoteParams;
export const REMOTE_METHODS = Object.keys(remoteParams) as RemoteMethod[];

type ToolHelp = {
  description: string;
  constraints?: string[];
  examples?: Record<string, unknown>[];
};
const targetRule =
  'Use an exact ref from snapshot/find OR both x and y; never combine ref with coordinates. Coordinates are top-viewport CSS pixels.';
// Adding a method without documentation is a TypeScript error. All browser
// semantics stay in this extension; the transport has no copy of this table.
export const toolHelp = {
  describe: {
    description:
      'Read the live browser guide and tool index; request method or methods for parameter schemas.',
    constraints: [
      'Supply method OR methods, not both. An empty object returns the guide and compact index.',
    ],
    examples: [{}, { methods: ['open', 'snapshot', 'click'] }],
  },
  info: {
    description:
      'Read extension version, capabilities and current task/tab. Does not start a task.',
  },
  start: {
    description: 'Create a dedicated browser task at a URL. Fails if a task already exists.',
    examples: [{ url: 'https://example.com/' }],
  },
  open: {
    description: 'Navigate the task tab to a URL; create a task first if none exists.',
    examples: [{ url: 'https://example.com/' }],
  },
  'new-tab': { description: 'Open another tab in the current task group (maximum 8 tabs).' },
  'switch-tab': {
    description:
      'Select a task tab as the automation target using its actual tabId; does not steal foreground focus.',
  },
  tabs: { description: 'List task-owned tabs and the selected automation target.' },
  frames: { description: 'List permitted frame IDs and URLs for scoped element queries.' },
  snapshot: {
    description:
      'Read page text and element refs across permitted frames. Use when no image is needed.',
    examples: [{ interactive: true }],
  },
  observe: {
    description:
      'Read text, fresh refs, PNG screenshot, viewport and page version together. Read the returned image with an image tool; do not request a second screenshot.',
    examples: [{ interactive: true }],
  },
  screenshot: {
    description:
      'Capture a PNG of the current task viewport. The image attachment must be read with an image tool.',
  },
  find: {
    description:
      'Find elements by CSS selector, traversing open Shadow DOM; return usable refs and state.',
    examples: [{ selector: 'input[type="search"]' }],
  },
  inspect: {
    description:
      'Read current element value, checked/disabled/expanded/visible/clickable state, focus, options and scrolling state. Sensitive values are hidden.',
  },
  click: {
    description: 'Click an element or viewport point using native pointer events.',
    constraints: [targetRule],
  },
  hover: {
    description: 'Move the pointer to an element or viewport point without clicking.',
    constraints: [targetRule],
  },
  'double-click': {
    description: 'Double-click an element or viewport point.',
    constraints: [targetRule],
  },
  'right-click': {
    description: 'Right-click an element or viewport point.',
    constraints: [targetRule],
  },
  drag: {
    description: 'Drag between elements/points, including pointer sliders and HTML drag-and-drop.',
    constraints: [`Both from and to: ${targetRule}`],
  },
  fill: { description: 'Replace an editable element’s text by selecting all and inserting text.' },
  type: { description: 'Insert text at the current caret in the referenced editable element.' },
  select: {
    description: 'Select native select options by value. Use clicks/keys for custom widgets.',
  },
  check: {
    description: 'Set checkbox/radio/switch checked state; leave already-correct state unchanged.',
  },
  scroll: {
    description: 'Scroll a referenced container, at a viewport point, or at viewport center.',
    constraints: ['Target is optional. If supplied: ' + targetRule],
  },
  keypress: {
    description: 'Send a page key, optionally to a referenced element, with modifiers.',
    constraints: [
      'key is one Unicode character or Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space. Browser chrome and OS shortcuts are unsupported.',
    ],
    examples: [{ key: 'Enter' }, { key: 'a', modifiers: ['Meta'] }],
  },
  back: { description: 'Initiate backward history navigation; follow with a loaded/URL wait.' },
  forward: { description: 'Initiate forward history navigation; follow with a loaded/URL wait.' },
  reload: { description: 'Reload the current task tab; follow with a loaded/URL wait.' },
  dialog: {
    description:
      'Inspect, accept or dismiss an open alert/confirm/prompt/beforeunload dialog. Can run while a browser action is waiting.',
    examples: [{ action: 'get' }, { action: 'accept', promptText: 'Example' }],
  },
  wait: {
    description:
      'Wait for an element, text, exact URL, page load or new task tab; return when the condition holds.',
    constraints: [
      'Use ref OR selector. attached/detached/visible/hidden/enabled/clickable/checked require one. text requires text; url requires the exact full URL. The CLI request timeout must exceed timeoutMs.',
    ],
    examples: [
      { condition: 'loaded' },
      { condition: 'visible', selector: '#results', timeoutMs: 10000 },
    ],
  },
  pause: {
    description:
      'Pause control and detach the debugger, retaining task tabs. Use when the owner must log in or enter sensitive input.',
  },
  finish: {
    description:
      'Release browser control and detach the debugger, retaining tabs. Does not itself send a final chat reply.',
  },
  stop: { description: 'Stop control, cancel queued actions and close temporary task-owned tabs.' },
  finalize: {
    description:
      'Close task-owned tabs except actual IDs in keep, then release/ungroup retained results. Empty keep closes all task tabs.',
  },
} satisfies Record<RemoteMethod, ToolHelp>;

type JsonSchema = Record<string, unknown>;
// Export the public shape of the Zod schemas already used at dispatch. Runtime
// refinements (cross-field rules and key validation) remain enforced by Zod and
// are explained in each tool's constraints. Unknown schema types fail loudly.
export function parameterSchema(schema: z.ZodTypeAny): JsonSchema {
  let result: JsonSchema;
  if (schema instanceof z.ZodOptional) return parameterSchema(schema.unwrap());
  if (schema instanceof z.ZodDefault)
    return { ...parameterSchema(schema.removeDefault()), default: schema._def.defaultValue() };
  if (schema instanceof z.ZodEffects) return parameterSchema(schema.innerType());
  if (schema instanceof z.ZodObject) {
    const properties: Record<string, JsonSchema> = {},
      required: string[] = [];
    for (const [name, value] of Object.entries(schema.shape) as [string, z.ZodTypeAny][]) {
      properties[name] = parameterSchema(value);
      if (!value.isOptional()) required.push(name);
    }
    result = { type: 'object', properties, required, additionalProperties: false };
  } else if (schema instanceof z.ZodString) {
    result = { type: 'string' };
    if (schema.minLength !== null) result.minLength = schema.minLength;
    if (schema.maxLength !== null) result.maxLength = schema.maxLength;
    if (schema.isURL) result.format = 'uri';
  } else if (schema instanceof z.ZodNumber) {
    result = { type: schema.isInt ? 'integer' : 'number' };
    if (schema.minValue !== null) result.minimum = schema.minValue;
    if (schema.maxValue !== null) result.maximum = schema.maxValue;
  } else if (schema instanceof z.ZodBoolean) result = { type: 'boolean' };
  else if (schema instanceof z.ZodEnum) result = { type: 'string', enum: schema.options };
  else if (schema instanceof z.ZodArray) {
    result = { type: 'array', items: parameterSchema(schema.element) };
    if (schema._def.minLength) result.minItems = schema._def.minLength.value;
    if (schema._def.maxLength) result.maxItems = schema._def.maxLength.value;
  } else throw new Error(`No parameter exporter for ${schema._def.typeName}`);
  if (schema.description) result.description = schema.description;
  return result;
}

type ToolCatalog = {
  schemaVersion: number;
  extensionVersion: string;
  instructions?: string;
  parameterLookup?: string;
  tools: (ToolHelp & { name: RemoteMethod; parameters?: JsonSchema })[];
};

export function describeTools(names?: RemoteMethod[]): ToolCatalog {
  const base = { schemaVersion: 1, extensionVersion: REMOTE_VERSION };
  if (names)
    return {
      ...base,
      tools: names.map((name) => ({
        name,
        ...toolHelp[name],
        parameters: parameterSchema(remoteParams[name]),
      })),
    };
  return {
    ...base,
    instructions,
    tools: REMOTE_METHODS.map((name) => ({ name, description: toolHelp[name].description })),
    parameterLookup:
      'Call describe with {"method":"name"} or {"methods":["name",...]} (up to 8) for validated parameter shapes, constraints and examples. Reuse descriptions within the task.',
  };
}
