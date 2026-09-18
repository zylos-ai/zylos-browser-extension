import { z } from 'zod';
import { actionParams } from './commands';
import { REMOTE_VERSION } from './remote';

// The same schemas validate local actions and generate the Agent's live reference.
const {
  pause: _pause,
  finish: _finish,
  stop: _stop,
  wait: _wait,
  screenshot: _screenshot,
  ...loopActionParams
} = actionParams;
export const browserParams = {
  ...loopActionParams,
  'use-current-tab': z.object({ contextId: z.string().uuid() }).strict(),
} as const;
export type BrowserMethod = keyof typeof browserParams;
export const BROWSER_METHODS = Object.keys(browserParams) as BrowserMethod[];

type ToolHelp = {
  description: string;
  constraints?: string[];
  examples?: Record<string, unknown>[];
};
const targetRule =
  'Use the complete ref from snapshot/find (for example @1a2b3c4d-e17) OR both x and y; never combine ref with coordinates. Coordinates are top-viewport CSS pixels.';
// Adding a method without documentation is a TypeScript error. All browser
// semantics stay in this extension; the transport has no copy of this table.
export const toolHelp = {
  'use-current-tab': {
    description:
      'Select the existing page attached to a user message for reading and actions, without reopening or regrouping it.',
    constraints: [
      'Use the exact contextId from that message, never a guessed tab ID. Contexts expire after 30 minutes or a worker restart. A navigated or closed page requires a new user message. Fresh evidence is returned automatically after selecting. User-owned tabs are never closed by task cleanup.',
    ],
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
  tabs: {
    description:
      'List task-owned tabs, the borrowed page if any, and the selected automation target.',
  },
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
  find: {
    description:
      'Find elements by CSS selector, traversing open Shadow DOM; return usable refs and state, including native video/audio playback facts in state.media.',
    examples: [{ selector: 'input[type="search"]' }, { selector: 'video,audio' }],
    constraints: [
      'Quote CSS attribute values containing punctuation: a[href*="/comments/"] is valid; a[href*=/comments/] is not.',
    ],
  },
  inspect: {
    description:
      'Read current control state, ariaLabel/title, focus, options and scroll. Native video/audio includes media playback facts (paused, ended, seeking, currentTime, duration, readyState, networkState, muted, volume, playbackRate, error). Sensitive values are hidden.',
    constraints: [
      'Use the state relevant to the goal: value for filled inputs, checked/selected/expanded for controls. A local field value does not prove a server-side save or submission.',
      'Native media facts also appear in find matches[].state.media. Scope to the intended player/frame; an ad or unrelated preview playing does not confirm the requested content.',
      'Media not paused, not ended, not seeking, with no error, readyState >= 3 and positive playbackRate indicates active playback with available data. If ambiguous, one subsequent inspect can confirm currentTime advances. A nonzero timestamp alone is not proof. duration is null when unknown or unbounded.',
      'Buffering does not justify repeatedly toggling play/pause. For a custom player without native media, inspect its visible state and report uncertainty if playback cannot be verified.',
    ],
  },
  click: {
    description: 'Click an element or viewport point using native pointer events.',
    constraints: [
      targetRule,
      'Read toggle/selection state before clicking; leave an already-correct state alone. Do not repeat clicks, saves or submissions as verification; inspect the requested outcome.',
    ],
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
      'A ref must identify a focusable element. A video or container is not necessarily focusable; reading it with find/inspect does not make it a keyboard target. A focus failure occurs before key dispatch; do not blindly retry without the ref, because that sends the key to the existing focus.',
      'Space and site-specific playback shortcuts can toggle state. Read the intended player state first; an already-correct or buffering player needs no toggle. Use a shortcut only when its target and effect are known.',
    ],
    examples: [{ key: 'Enter' }, { key: 'a', modifiers: ['Meta'] }],
  },
  back: { description: 'Initiate backward history navigation in the current task tab.' },
  forward: { description: 'Initiate forward history navigation in the current task tab.' },
  reload: { description: 'Initiate a reload of the current task tab.' },
  dialog: {
    description:
      'Inspect, accept or dismiss an open alert/confirm/prompt/beforeunload dialog. Can run while a browser action is waiting.',
    examples: [{ action: 'get' }, { action: 'accept', promptText: 'Example' }],
  },
} satisfies Record<BrowserMethod, ToolHelp>;

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
  if (schema instanceof z.ZodDiscriminatedUnion)
    return { oneOf: schema.options.map((option: z.ZodTypeAny) => parameterSchema(option)) };
  if (schema instanceof z.ZodLiteral) return { type: typeof schema.value, const: schema.value };
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
    if (schema.isUUID) result.format = 'uuid';
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
  tools: (ToolHelp & { name: BrowserMethod; parameters?: JsonSchema })[];
};

export function describeTools(names: BrowserMethod[]): ToolCatalog {
  return {
    schemaVersion: 1,
    extensionVersion: REMOTE_VERSION,
    tools: names.map((name) => ({
      name,
      ...toolHelp[name],
      parameters: parameterSchema(browserParams[name]),
    })),
  };
}
