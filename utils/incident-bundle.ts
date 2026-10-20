import type { DetailedCapture } from './detailed-diagnostics';
import type { PageDocument } from './page-reader';
import {
  captureIncidentPageState,
  pinIncidentDocument,
  type IncidentPageCapture,
} from './automation/incident-page-state';

type Capture = ReturnType<DetailedCapture['preview']>;
type Context = { task?: number; operation?: number };
type Scope = { consent: string; generation: number; navigation: number; tabId?: number };
type Runtime = {
  connected: boolean;
  control: boolean;
  granted: boolean;
  scope: 'none' | 'borrowed' | 'owned';
  groupReference: 'none' | 'assigned';
};
type Correlation = Context & {
  taskId: string;
  actionId: string;
  method: string;
  startedAt: number;
  endedAt?: number;
  outcome: 'running' | 'completed' | 'error';
};
type Incident = Context & {
  incidentId: string;
  taskId?: string;
  actionId?: string;
  trigger: 'debugger-detach' | 'control-lost' | 'operation-error';
  reason: 'target_closed' | 'canceled_by_user' | 'other';
  triggeredAt: number;
  runtimeAtTrigger: Runtime;
  triggerFacts: {
    trigger: Incident['trigger'];
    reason: Incident['reason'];
    triggeredAt: number;
    runtimeAtTrigger: Runtime;
  }[];
  pageBefore: IncidentPageCapture | { status: 'pending'; observedAt: number };
  pageState: IncidentPageCapture | { status: 'pending'; observedAt: number };
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const actionId = /^[0-9a-f-]{36}(?::[a-zA-Z0-9_-]{1,32}){0,5}$/;
export const INCIDENT_BEFORE_MS = 30_000;
export const INCIDENT_AFTER_MS = 2_000;

/** Only protocol-generated identifiers and non-value page state enter this buffer. */
export class IncidentCapture {
  private correlations: Correlation[] = [];
  private incidents: Incident[] = [];
  private startedAt = 0;
  private truncated = false;
  private document?: { scope: Scope; pending: Promise<PageDocument | undefined> };
  private before = new Map<Correlation, Promise<IncidentPageCapture>>();
  private actionScopes = new WeakMap<Correlation, Scope>();
  private incidentScopes = new WeakMap<Incident, Scope>();
  private evictedIncidents = 0;
  constructor(
    private scope: () => Scope,
    private runtime: () => Runtime = () => ({
      connected: false,
      control: false,
      granted: false,
      scope: 'none',
      groupReference: 'none',
    }),
  ) {}
  clear() {
    this.correlations = [];
    this.incidents = [];
    this.document = undefined;
    this.before.clear();
    this.startedAt = Date.now();
    this.truncated = false;
    this.evictedIncidents = 0;
  }
  private valid(scope: Scope) {
    const now = this.scope();
    return !!scope.consent && now.consent === scope.consent && now.generation === scope.generation;
  }
  private sameDocument(scope: Scope) {
    const now = this.scope();
    return (
      this.valid(scope) &&
      now.navigation === scope.navigation &&
      (now.tabId === undefined || now.tabId === scope.tabId)
    );
  }
  begin(context: Context, taskId: unknown, id: string, method: string) {
    try {
      return this.collectBegin(context, taskId, id, method);
    } catch {
      return undefined;
    }
  }
  private collectBegin(context: Context, taskId: unknown, id: string, method: string) {
    const scope = { ...this.scope() };
    if (!scope.consent) return undefined;
    if (
      scope.tabId !== undefined &&
      (!this.document ||
        this.document.scope.tabId !== scope.tabId ||
        this.document.scope.navigation !== scope.navigation ||
        this.document.scope.generation !== scope.generation ||
        this.document.scope.consent !== scope.consent)
    ) {
      this.document = {
        scope,
        pending: pinIncidentDocument(scope.tabId, () => this.sameDocument(scope)),
      };
    }
    if (typeof taskId !== 'string' || !uuid.test(taskId) || !actionId.test(id) || id.length > 200)
      return undefined;
    const entry: Correlation = {
      ...context,
      taskId,
      actionId: id,
      method: /^[a-z-]{1,40}$/.test(method) ? method : 'other',
      startedAt: Date.now(),
      outcome: 'running',
    };
    if (this.correlations.length >= 256) {
      this.before.delete(this.correlations.shift()!);
      this.truncated = true;
    }
    this.correlations.push(entry);
    this.actionScopes.set(entry, scope);
    const document = this.document;
    if (document && this.sameDocument(document.scope)) {
      const pending = document.pending
        .then((expected) =>
          expected && this.sameDocument(scope)
            ? captureIncidentPageState(expected, () => this.sameDocument(scope))
            : { status: 'stale' as const, observedAt: Date.now() },
        )
        .catch(() => ({ status: 'unavailable' as const, observedAt: Date.now() }));
      this.before.set(entry, pending);
    }
    return { entry, scope };
  }
  end(handle: ReturnType<IncidentCapture['begin']>, outcome: 'completed' | 'error') {
    try {
      this.collectEnd(handle, outcome);
    } catch {
      /* Diagnostics cannot affect actions. */
    }
  }
  private collectEnd(handle: ReturnType<IncidentCapture['begin']>, outcome: 'completed' | 'error') {
    if (!handle || !this.valid(handle.scope) || !this.correlations.includes(handle.entry)) return;
    handle.entry.endedAt = Date.now();
    handle.entry.outcome = outcome;
  }
  trigger(context: Context, trigger: Incident['trigger'], reason?: string) {
    try {
      this.collectTrigger(context, trigger, reason);
    } catch {
      /* Diagnostics cannot affect actions. */
    }
  }
  private collectTrigger(context: Context, trigger: Incident['trigger'], reason?: string) {
    const scope = { ...this.scope() };
    if (!scope.consent) return;
    const now = Date.now();
    const match = [...this.correlations]
      .reverse()
      .find(
        (item) =>
          item.task === context.task &&
          !!this.actionScopes.get(item) &&
          this.valid(this.actionScopes.get(item)!) &&
          (context.operation === undefined
            ? item.outcome === 'running'
            : item.operation === context.operation) &&
          (trigger !== 'debugger-detach' ||
            (context.operation !== undefined && item.outcome === 'running')),
      );
    const actionScope = match && this.actionScopes.get(match);
    const fact = {
      trigger,
      reason: (reason === 'target_closed' || reason === 'canceled_by_user'
        ? reason
        : 'other') as Incident['reason'],
      triggeredAt: now,
      runtimeAtTrigger: { ...this.runtime() },
    };
    const existing =
      match &&
      actionScope &&
      this.incidents.find((item) => {
        const priorScope = this.incidentScopes.get(item);
        return (
          item.task === match.task &&
          item.taskId === match.taskId &&
          item.actionId === match.actionId &&
          priorScope?.consent === actionScope.consent &&
          priorScope.generation === actionScope.generation &&
          priorScope.navigation === actionScope.navigation &&
          priorScope.tabId === actionScope.tabId &&
          now - item.triggeredAt >= 0 &&
          now - item.triggeredAt < INCIDENT_AFTER_MS
        );
      });
    if (existing) {
      if (!existing.triggerFacts.some((item) => item.trigger === trigger)) {
        existing.triggerFacts.push(fact);
        if (trigger === 'debugger-detach') Object.assign(existing, fact);
      }
      return;
    }
    const incident: Incident = {
      ...context,
      incidentId: crypto.randomUUID(),
      ...(match ? { taskId: match.taskId, actionId: match.actionId } : {}),
      ...fact,
      triggerFacts: [fact],
      pageBefore: { status: 'unavailable', observedAt: now },
      pageState: { status: 'pending', observedAt: now },
    };
    if (this.incidents.length >= 8) {
      const ordinary = this.incidents.findIndex(
        (item) => !item.triggerFacts.some((fact) => fact.trigger === 'debugger-detach'),
      );
      this.truncated = true;
      this.evictedIncidents++;
      if (ordinary < 0 && trigger !== 'debugger-detach') return;
      this.incidents.splice(ordinary < 0 ? 0 : ordinary, 1);
    }
    this.incidents.push(incident);
    this.incidentScopes.set(incident, actionScope ?? scope);
    const before = match && this.before.get(match);
    if (before) {
      incident.pageBefore = { status: 'pending', observedAt: now };
      void before
        .then((result) => {
          if (this.valid(scope) && this.incidents.includes(incident)) incident.pageBefore = result;
        })
        .catch(() => {
          /* A diagnostic callback must not create an unhandled rejection. */
        });
    }
    const document = this.document;
    if (trigger === 'control-lost' || !document || !this.sameDocument(document.scope)) {
      incident.pageState = { status: 'unavailable', observedAt: Date.now() };
      return;
    }
    void document.pending
      .then(async (expected) => {
        if (!expected || !this.sameDocument(document.scope))
          return { status: 'stale' as const, observedAt: Date.now() };
        return captureIncidentPageState(expected, () => this.sameDocument(document.scope));
      })
      .then((result) => {
        if (this.valid(scope) && this.incidents.includes(incident)) incident.pageState = result;
      })
      .catch(() => {
        if (this.valid(scope) && this.incidents.includes(incident))
          incident.pageState = { status: 'unavailable', observedAt: Date.now() };
      });
  }
  bundle(capture: Capture, runtime: Runtime) {
    const now = Date.now();
    const incidents = this.incidents.map((incident) => {
      const from = incident.triggeredAt - INCIDENT_BEFORE_MS;
      const to = incident.triggeredAt + INCIDENT_AFTER_MS;
      const gaps = ['partial-diagnostic-capture'];
      if (this.startedAt > from) gaps.push('pre-window-not-captured');
      if (now < to) gaps.push('post-window-pending');
      if (capture.dropped || this.truncated) gaps.push('records-dropped');
      if (this.evictedIncidents) gaps.push('incidents-evicted');
      const correlation = this.correlations.find(
        (item) => item.taskId === incident.taskId && item.actionId === incident.actionId,
      );
      const actionStartedAt = correlation?.startedAt;
      const relation =
        incident.pageBefore.status !== 'captured' || actionStartedAt === undefined
          ? ('unknown' as const)
          : incident.pageBefore.observedAt < actionStartedAt
            ? ('before-action' as const)
            : incident.pageBefore.observedAt === actionStartedAt
              ? ('same-millisecond' as const)
              : ('after-action-start' as const);
      if (relation === 'after-action-start') gaps.push('pre-state-after-action-start');
      if (relation === 'same-millisecond') gaps.push('pre-state-order-unresolved');
      if (incident.pageState.status !== 'captured')
        gaps.push(`page-state-${incident.pageState.status}`);
      else if (incident.pageState.observedAt < incident.triggeredAt)
        gaps.push('page-state-before-trigger');
      else if (incident.pageState.observedAt === incident.triggeredAt)
        gaps.push('page-state-order-unresolved');
      if (incident.pageBefore.status !== 'captured')
        gaps.push(`page-before-${incident.pageBefore.status}`);
      else if (incident.pageBefore.observedAt > incident.triggeredAt)
        gaps.push('pre-state-not-before-trigger');
      if (!incident.taskId || !incident.actionId) gaps.push('correlation-unavailable');
      else if (
        !this.correlations.some(
          (item) => item.taskId === incident.taskId && item.actionId === incident.actionId,
        )
      )
        gaps.push('correlation-evicted');
      return {
        ...incident,
        pageBeforeTiming: { actionStartedAt, relation },
        window: { from, to, through: Math.min(now, to), complete: false as const, gaps },
        recordSequences: capture.records
          .filter(
            (record) =>
              record.at >= from &&
              record.at <= to &&
              (incident.task === undefined || record.task === incident.task),
          )
          .map((record) => record.sequence),
      };
    });
    return {
      schemaVersion: 2 as const,
      kind: 'browser-incident-bundle' as const,
      capture,
      clock: {
        epoch: 'unix-ms' as const,
        source: 'extension-Date.now' as const,
        remoteComparable: false as const,
      },
      previewRuntime: { ...runtime },
      correlations: structuredClone(this.correlations),
      incidents: structuredClone(incidents),
      limitations: [
        'No root-cause inference. Clock alignment with Remote is unverified.',
        'Limited non-value page state only; no screenshots, full DOM, page text, input values or URLs.',
        'Native errors may contain private text under the existing explicit detailed-capture consent.',
        'Capture is bounded and partial; pending post-window records are not added to an already frozen share.',
      ],
    };
  }
}
