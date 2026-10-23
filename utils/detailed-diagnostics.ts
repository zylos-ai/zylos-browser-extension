import { z } from 'zod';

export const DETAIL_TTL = 10 * 60_000;
export const DETAIL_BYTES = 1024 * 1024;
export const FROZEN_DETAIL_TTL = 24 * 60 * 60_000;
export const FROZEN_DETAIL_BYTES = 2 * 1024 * 1024;
export type DetailChange = 'changed' | 'capture-expired' | 'frozen' | 'frozen-expired';
const nativeError = Error;
const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get;
const nativeErrorPrototypes = new Set([
  Error.prototype,
  TypeError.prototype,
  RangeError.prototype,
  ReferenceError.prototype,
  SyntaxError.prototype,
  URIError.prototype,
  EvalError.prototype,
  AggregateError.prototype,
]);
function safeStackFormatting(error: object) {
  if (!nativeErrorPrototypes.has(Object.getPrototypeOf(error))) return false;
  let object: object | null = nativeError;
  const seen = new Set<object>();
  for (let depth = 0; object && depth < 8; depth++, object = Object.getPrototypeOf(object)) {
    if (seen.has(object)) return false;
    seen.add(object);
    const formatter = Object.getOwnPropertyDescriptor(object, 'prepareStackTrace');
    if (formatter && (!('value' in formatter) || formatter.value !== undefined)) return false;
  }
  if (object) return false;
  object = error;
  seen.clear();
  for (let depth = 0; object && depth < 8; depth++, object = Object.getPrototypeOf(object)) {
    if (seen.has(object)) return false;
    seen.add(object);
    for (const name of ['name', 'message']) {
      const field = Object.getOwnPropertyDescriptor(object, name);
      if (field && (!('value' in field) || typeof field.value !== 'string')) return false;
    }
  }
  return !object;
}
export const detailEventSchema = z
  .object({
    kind: z.enum(['console', 'error', 'unhandledrejection', 'panel-loss']),
    level: z.enum(['debug', 'log', 'info', 'warn', 'error']),
    at: z.number().finite(),
    text: z.string().max(16384),
    truncated: z.boolean(),
    lost: z.number().int().min(0).max(1000000).optional(),
  })
  .strict();
export type DetailEvent = z.infer<typeof detailEventSchema>;
export const detailStateSchema = z.object({
  enabled: z.boolean(),
  consent: z.string(),
  expiresAt: z.number(),
  count: z.number(),
  bytes: z.number(),
  dropped: z.number(),
  truncated: z.number(),
  exportConsent: z.string().optional(),
  exportExpiresAt: z.number().optional(),
  frozenAt: z.number().optional(),
  frozenCount: z.number().optional(),
});

export function redactDetail(text: string, secrets: string[] = []) {
  for (const secret of secrets)
    if (secret.length >= 4) text = text.split(secret).join('[REDACTED]');
  return text
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(
      /((?:["']?)(?:password|api[_-]?key|access[_-]?token|secret|authorization|cookie)["']?\s*[=:]\s*["']?)[^\s,"';]+/gi,
      '$1[REDACTED]',
    )
    .replace(/https?:\/\/[^\s"'<>]+/gi, (value) => {
      try {
        const url = new URL(value);
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString();
      } catch {
        return '[URL]';
      }
    });
}

/** Never enumerate arbitrary objects: proxies can execute traps during reflection. */
export function serializeDetail(args: unknown[], secrets: string[] = []) {
  let truncated = args.length > 20;
  const textOf = (value: string) => {
    if (value.length > 32768) {
      truncated = true;
      value = value.slice(0, 32768);
      value = value.slice(0, Math.max(0, value.search(/\S+$/)));
    }
    value = redactDetail(value, secrets);
    if (value.length > 8192) {
      truncated = true;
      value = value.slice(0, 8192);
      value = value.slice(0, Math.max(0, value.search(/\S+$/)));
    }
    return value;
  };
  const pieces = args.slice(0, 20).map((value) => {
    if (value === null) return 'null';
    if (typeof value === 'string') {
      return textOf(value);
    }
    if (['undefined', 'boolean', 'number'].includes(typeof value)) return String(value);
    // Chrome exposes stack through a shared native getter. Invoke only that
    // cached intrinsic with default formatting and plain native Error fields.
    // Prototype/descriptor reflection can trap on a Proxy: exceptions are contained.
    try {
      if (
        value &&
        typeof value === 'object' &&
        nativeErrorPrototypes.has(Object.getPrototypeOf(value))
      ) {
        return ['name', 'message', 'stack']
          .map((key) => {
            if (key === 'stack' && !safeStackFormatting(value)) {
              truncated = true;
              return 'stack: [unsafe formatter omitted]';
            }
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor) return '';
            if (!('value' in descriptor)) {
              if (key === 'stack' && nativeStackGetter && descriptor.get === nativeStackGetter) {
                const stack = Reflect.apply(nativeStackGetter!, value, []);
                if (typeof stack === 'string') return `stack: ${textOf(stack)}`;
              }
              truncated = true;
              return `${key}: [accessor omitted]`;
            }
            if (typeof descriptor.value !== 'string') {
              truncated = true;
              return `${key}: [non-string omitted]`;
            }
            return `${key}: ${textOf(descriptor.value)}`;
          })
          .filter(Boolean)
          .join('\n');
      }
    } catch {
      truncated = true;
      return '[uninspectable object]';
    }
    truncated = true;
    return `[${typeof value} omitted]`;
  });
  let text = pieces.join(' ');
  if (text.length > 16384) {
    truncated = true;
    text = text.slice(0, 16384);
    text = text.slice(0, Math.max(0, text.search(/\S+$/)));
  }
  return { text, truncated };
}

export class DetailedCapture {
  private token = '';
  private captureId = '';
  private expiresAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private frozenTimer?: ReturnType<typeof setTimeout>;
  private frozen?: { token: string; at: number; expiresAt: number; text: string; count: number };
  private records: (DetailEvent & {
    source: 'background' | 'sidepanel';
    sequence: number;
    task?: number;
    operation?: number;
  })[] = [];
  private bytes = 0;
  private dropped = 0;
  private truncated = 0;
  private sequence = 0;
  readonly runtimeEpoch = crypto.randomUUID();
  constructor(
    private changed: (reason: DetailChange) => void,
    private secrets: () => string[] = () => [],
  ) {}
  clear() {
    clearTimeout(this.frozenTimer);
    this.frozen = undefined;
    this.clearLive();
    this.changed('changed');
  }
  private clearLive() {
    clearTimeout(this.timer);
    this.token = '';
    this.captureId = '';
    this.expiresAt = 0;
    this.records = [];
    this.bytes = 0;
    this.dropped = 0;
    this.truncated = 0;
    this.sequence = 0;
  }
  private expireCapture() {
    this.clearLive();
    this.changed('capture-expired');
  }
  private expireFrozen() {
    clearTimeout(this.frozenTimer);
    this.frozen = undefined;
    this.changed('frozen-expired');
  }
  enable() {
    this.clear();
    this.token = crypto.randomUUID();
    this.captureId = crypto.randomUUID();
    this.expiresAt = Date.now() + DETAIL_TTL;
    this.timer = setTimeout(() => this.expireCapture(), DETAIL_TTL);
    this.changed('changed');
    return this.state();
  }
  state() {
    if (this.token && Date.now() >= this.expiresAt) this.expireCapture();
    if (this.frozen && Date.now() >= this.frozen.expiresAt) this.expireFrozen();
    return {
      enabled: !!this.token,
      consent: this.token,
      expiresAt: this.expiresAt,
      count: this.records.length,
      bytes: this.bytes,
      dropped: this.dropped,
      truncated: this.truncated,
      exportConsent: this.frozen?.token ?? this.token,
      exportExpiresAt: this.frozen?.expiresAt ?? this.expiresAt,
      frozenAt: this.frozen?.at,
      frozenCount: this.frozen?.count,
    };
  }
  /** The caller supplies an already redacted incident bundle, never arbitrary page data. */
  freeze(token: string, snapshot: unknown) {
    if (!this.valid(token)) return false;
    try {
      const at = Date.now();
      const expiresAt = at + FROZEN_DETAIL_TTL;
      const value = structuredClone(snapshot) as {
        capture?: { records?: unknown[] };
        limitations?: unknown;
      };
      // Retention is stated inside the existing limitations list, not as a new
      // top-level field, so a negotiated v2 bundle stays valid for Remote.
      const retention = `Frozen fault snapshot taken ${new Date(at).toISOString()}; kept in extension memory until ${new Date(expiresAt).toISOString()} (maximum ${FROZEN_DETAIL_BYTES} bytes); background restart removes it.`;
      if (Array.isArray(value.limitations))
        value.limitations = [...value.limitations.slice(0, 31), retention];
      const text = JSON.stringify(value, null, 2);
      if (new TextEncoder().encode(text).length > FROZEN_DETAIL_BYTES) return false;
      clearTimeout(this.frozenTimer);
      this.frozen = {
        token: crypto.randomUUID(),
        at,
        expiresAt,
        text,
        count: value.capture?.records?.length ?? 0,
      };
      this.frozenTimer = setTimeout(() => this.expireFrozen(), FROZEN_DETAIL_TTL);
      this.changed('frozen');
      return true;
    } catch {
      return false;
    }
  }
  exportContext() {
    const state = this.state();
    return { consent: state.exportConsent, expiresAt: state.exportExpiresAt };
  }
  validExport(token: string) {
    return !!token && this.exportContext().consent === token;
  }
  frozenPreview(token: string): unknown | undefined {
    this.state();
    if (this.frozen?.token === token) return JSON.parse(this.frozen.text);
    if (!this.validExport(token)) throw new Error('ui.error.detailedExpired');
    return undefined;
  }
  valid(token: string) {
    return !!token && this.state().consent === token;
  }
  append(
    token: string,
    source: 'background' | 'sidepanel',
    raw: unknown,
    context: { task?: number; operation?: number } = {},
  ) {
    if (!this.valid(token)) return false;
    const parsed = detailEventSchema.safeParse(raw);
    if (!parsed.success) return false;
    const clean = serializeDetail([parsed.data.text], this.secrets());
    const record = {
      ...parsed.data,
      text: clean.text,
      truncated: parsed.data.truncated || clean.truncated,
      source,
      sequence: ++this.sequence,
      ...context,
    };
    const size = new TextEncoder().encode(JSON.stringify(record)).length;
    this.truncated += Number(record.truncated);
    this.dropped += record.lost ?? 0;
    if (size > DETAIL_BYTES) {
      this.dropped++;
      return false;
    }
    while (this.records.length >= 1000 || this.bytes + size > DETAIL_BYTES) {
      this.bytes -= new TextEncoder().encode(JSON.stringify(this.records.shift())).length;
      this.dropped++;
    }
    this.records.push(record);
    this.bytes += size;
    return true;
  }
  preview(token: string) {
    if (!this.valid(token)) throw new Error('ui.error.detailedExpired');
    // The exported capture keeps the negotiated v1 field set; export-token and
    // frozen-snapshot state are local UI fields that Remote validation rejects.
    const {
      consent: _consent,
      exportConsent: _exportConsent,
      exportExpiresAt: _exportExpiresAt,
      frozenAt: _frozenAt,
      frozenCount: _frozenCount,
      ...state
    } = this.state();
    return {
      schemaVersion: 1,
      ...state,
      runtimeEpoch: this.runtimeEpoch,
      captureId: this.captureId,
      extensionVersion: chrome.runtime.getManifest().version,
      build: typeof __DETAIL_BUILD__ === 'undefined' ? 'unavailable' : __DETAIL_BUILD__,
      exportedAt: new Date().toISOString(),
      partial: true,
      limits: { durationMs: DETAIL_TTL, bytes: DETAIL_BYTES, events: 1000, textChars: 16384 },
      limitations:
        'Extension background/sidepanel and bounded controlled top-document iframe metadata only. No webpage logs, CDP arguments/results or iframe URLs. Iframe probe omits frame documents and shadow roots; at most 2 minutes, 256 iframe IDs and 512 events; polling, navigation, denial and limits may lose events. Objects omitted; Error own strings or whitelisted native stack getter with default formatting only. Proxy reflection may execute traps. Pattern redaction is incomplete. Panel closure/crash may lose unreported events.',
      records: structuredClone(this.records),
    };
  }
}
declare const __DETAIL_BUILD__: string;
