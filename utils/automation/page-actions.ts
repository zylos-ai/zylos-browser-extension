import type { Command } from '../commands';
import type { Point } from './types';
import { collectFrames, frameAllowed, type Frame, type Send } from './frames';
import domAction from './injected/dom-action.js?raw';
import pageQuery from './injected/page-query.js?raw';
import pageReadiness from './injected/page-readiness.js?raw';
import type { PageProbe } from './page-stability';
import {
  hasArea,
  intersect,
  visibleLayout,
  viewportStyles,
  type LayoutSnapshot,
  type Rect,
} from './viewport';

export type ElementRef = { backendNodeId: number; generation: number; frame: Frame };
export type Target = { ref?: string; x?: number; y?: number };
export type Element = { objectId: string; frame: Frame };
export type ActionsIO = {
  send: Send;
  mouse: (params: Record<string, unknown>) => Promise<unknown>;
  check: () => void;
  preview: (action: string, point: Point) => Promise<unknown>;
  refs: Map<string, ElementRef>;
  generation: number;
  dragData: () => any;
};
function fail(code: string, message = code): never {
  throw Object.assign(new Error(message), { code });
}
const mask = (values: string[] = []) =>
  values.reduce((n, v) => n | ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 }[v] || 0), 0);
const transient = (error: unknown) =>
  error instanceof Error &&
  /detached|not found|Could not find|Cannot find|context.*destroyed|No frame/i.test(error.message);

export class PageActions {
  constructor(private io: ActionsIO) {}
  async frames() {
    return collectFrames(this.io.send);
  }
  async safeFrames() {
    const frames = await this.frames();
    const allowed = (f: Frame): boolean =>
      frameAllowed(f) && (!f.parentId || !frames.some((p) => p.id === f.parentId && !allowed(p)));
    return frames.filter(allowed);
  }
  private async call(element: Element, action: string, option?: unknown): Promise<any> {
    const response = await this.io.send(
      'Runtime.callFunctionOn',
      {
        objectId: element.objectId,
        functionDeclaration: domAction,
        arguments: [{ value: action }, { value: option }],
        returnByValue: true,
      },
      element.frame.sessionId,
    );
    if (response.exceptionDetails) {
      const message =
        response.exceptionDetails.exception?.description?.split('\n')[0] ||
        response.exceptionDetails.text;
      fail(/Password|OTP/.test(message) ? 'SENSITIVE_INPUT' : 'ELEMENT_ERROR', message);
    }
    return response.result?.value;
  }
  async query(frame: Frame, action: string, value?: unknown, byValue = true): Promise<any> {
    const world = await this.io.send(
      'Page.createIsolatedWorld',
      { frameId: frame.id, worldName: 'coco-actions' },
      frame.sessionId,
    );
    const response = await this.io.send(
      'Runtime.callFunctionOn',
      {
        executionContextId: world.executionContextId,
        functionDeclaration: pageQuery,
        arguments: [{ value: action }, { value }],
        returnByValue: byValue,
        objectGroup: 'coco-browser',
      },
      frame.sessionId,
    );
    if (response.exceptionDetails)
      fail(
        'INVALID_SELECTOR',
        response.exceptionDetails.exception?.description?.split('\n')[0] || 'Page query failed',
      );
    return byValue ? response.result?.value : response.result;
  }
  async resolve(ref: string): Promise<Element> {
    // Accept a missing display marker only for the full, exact generated ID.
    // Still require the same live ref map and generation; never guess a node.
    const canonical = /^[a-f0-9]{8}-e\d+$/.test(ref) ? `@${ref}` : ref;
    const entry = this.io.refs.get(canonical);
    if (!entry || entry.generation !== this.io.generation)
      fail('STALE_ELEMENT', 'Take a new snapshot or find');
    const frames = await this.safeFrames();
    const frame = frames.find(
      (f) =>
        f.id === entry.frame.id &&
        f.sessionId === entry.frame.sessionId &&
        f.url === entry.frame.url,
    );
    if (!frame) fail('STALE_ELEMENT', 'Element frame navigated or is no longer available');
    try {
      const resolved = await this.io.send(
        'DOM.resolveNode',
        { backendNodeId: entry.backendNodeId, objectGroup: 'coco-browser' },
        frame.sessionId,
      );
      const element = { objectId: resolved.object.objectId, frame };
      await this.call(element, 'validate');
      return element;
    } catch (error) {
      if (transient(error)) fail('STALE_ELEMENT');
      throw error;
    }
  }
  async inspect(ref: string) {
    const element = await this.resolve(ref);
    const state = await this.call(element, 'inspect');
    if (state?.clickable && element.frame.parentId) {
      try {
        await this.point({ ref }, false);
      } catch (error) {
        this.io.check();
        if (['ELEMENT_COVERED', 'ELEMENT_ERROR'].includes((error as { code?: string }).code || ''))
          state.clickable = false;
        else throw error;
      }
    }
    return state;
  }
  async find(selector: string, frameId?: string) {
    const frames = await this.safeFrames();
    if (frameId && !frames.some((f) => f.id === frameId)) fail('FRAME_UNAVAILABLE');
    const matches: { ref: string; frameId: string; state: any }[] = [];
    for (const frame of frames.filter((f) => !frameId || f.id === frameId)) {
      const array = await this.query(frame, 'query', selector, false);
      if (!array?.objectId) continue;
      try {
        const properties = await this.io.send(
          'Runtime.getProperties',
          { objectId: array.objectId, ownProperties: true },
          frame.sessionId,
        );
        for (const p of properties.result || []) {
          if (!/^\d+$/.test(p.name) || !p.value?.objectId) continue;
          const node = await this.io.send(
            'DOM.describeNode',
            { objectId: p.value.objectId },
            frame.sessionId,
          );
          const ref = `@${crypto.randomUUID().slice(0, 8)}-e${matches.length + 1}`;
          if (this.io.refs.size >= 2000) fail('REF_LIMIT', 'Take a fresh snapshot');
          this.io.refs.set(ref, {
            backendNodeId: node.node.backendNodeId,
            generation: this.io.generation,
            frame,
          });
          const state = frame.parentId
            ? await this.inspect(ref)
            : await this.call({ objectId: p.value.objectId, frame }, 'inspect');
          matches.push({ ref, frameId: frame.id, state });
          if (matches.length >= 100) return { matches, truncated: true };
        }
      } finally {
        await this.io
          .send('Runtime.releaseObject', { objectId: array.objectId }, frame.sessionId)
          .catch(() => {});
      }
    }
    return { matches, truncated: false };
  }
  private async frameViewport(
    frame: Frame,
    frames: Frame[],
    cache: Map<string, Rect>,
  ): Promise<Rect> {
    const cached = cache.get(frame.id);
    if (cached) return cached;
    let viewport: Rect = await this.query(frame, 'viewport');
    if (frame.parentId) {
      const parent = frames.find((f) => f.id === frame.parentId);
      if (!parent) fail('FRAME_UNAVAILABLE');
      const parentViewport = await this.frameViewport(parent, frames, cache);
      const owner = await this.io.send(
        'DOM.getFrameOwner',
        { frameId: frame.id },
        parent.sessionId,
      );
      const resolved = await this.io.send(
        'DOM.resolveNode',
        { backendNodeId: owner.backendNodeId, objectGroup: 'coco-browser' },
        parent.sessionId,
      );
      const geometry = await this.call(
        { objectId: resolved.object.objectId, frame: parent },
        'frame-geometry',
      );
      if (!(geometry.sx > 0 && geometry.sy > 0)) return { x: 0, y: 0, width: 0, height: 0 };
      const clip = intersect(parentViewport, geometry.clip);
      viewport = intersect(viewport, {
        x: (clip.x - geometry.x) / geometry.sx,
        y: (clip.y - geometry.y) / geometry.sy,
        width: clip.width / geometry.sx,
        height: clip.height / geometry.sy,
      });
    }
    cache.set(frame.id, viewport);
    return viewport;
  }
  async readiness(target: Target = {}): Promise<PageProbe> {
    const frames = await this.safeFrames();
    const cache = new Map<string, Rect>();
    const samples: {
      frame: string;
      signature: string;
      busy: boolean;
      limited: boolean;
      scroll: PageProbe['scroll'];
    }[] = [];
    for (const frame of frames.slice(0, 12)) {
      const viewport = await this.frameViewport(frame, frames, cache);
      if (!hasArea(viewport)) continue;
      const world = await this.io.send(
        'Page.createIsolatedWorld',
        { frameId: frame.id, worldName: 'coco-actions' },
        frame.sessionId,
      );
      const response = await this.io.send(
        'Runtime.callFunctionOn',
        {
          executionContextId: world.executionContextId,
          functionDeclaration: pageReadiness,
          arguments: [
            { value: viewport },
            { value: frame.parentId ? {} : { x: target.x, y: target.y } },
          ],
          returnByValue: true,
        },
        frame.sessionId,
      );
      if (response.exceptionDetails || !response.result?.value?.signature)
        fail('OBSERVATION_UNAVAILABLE');
      samples.push({ frame: frame.id, ...response.result.value });
    }
    let scroll = samples[0]?.scroll;
    if (target.ref) {
      // Keep the exact container being scrolled; do not confuse its bottom with the document's.
      scroll = await this.call(await this.resolve(target.ref), 'scroll-state');
    }
    return {
      signature: JSON.stringify([samples.map((s) => [s.frame, s.signature]), scroll]),
      busy: samples.some((s) => s.busy),
      limited: frames.length > 12 || !samples.length || samples.some((s) => s.limited),
      frames: samples.map((s) => s.frame),
      scroll,
      atBoundary: !!scroll && scroll.y + scroll.clientHeight >= scroll.height - 2,
    };
  }
  async snapshot(interactiveOnly: boolean, header: string[], viewportOnly = false) {
    this.io.refs.clear();
    const frames = await this.safeFrames();
    const lines = [...header],
      warnings: string[] = [];
    const serial = crypto.randomUUID().slice(0, 8);
    const interactive = new Set([
      'button',
      'link',
      'textbox',
      'searchbox',
      'combobox',
      'checkbox',
      'radio',
      'switch',
      'tab',
      'menuitem',
      'slider',
      'spinbutton',
      'listbox',
      'option',
    ]);
    let count = 0;
    let chars = lines.join('\n').length;
    const layouts = new Map<string | undefined, LayoutSnapshot>();
    const viewports = new Map<string, Rect>();
    const result = (truncated = false) => ({
      text: lines.join('\n'),
      warnings,
      scope: viewportOnly ? 'viewport' : 'document',
      truncated,
      nodeCount: count,
    });
    for (const frame of frames) {
      try {
        let visible: ReturnType<typeof visibleLayout> | undefined;
        if (viewportOnly) {
          const viewport = await this.frameViewport(frame, frames, viewports);
          if (!hasArea(viewport)) continue;
          let layout = layouts.get(frame.sessionId);
          if (!layout) {
            layout = (await this.io.send(
              'DOMSnapshot.captureSnapshot',
              { computedStyles: viewportStyles },
              frame.sessionId,
            )) as LayoutSnapshot;
            layouts.set(frame.sessionId, layout);
          }
          const document = layout.documents.find((d) => layout!.strings[d.frameId] === frame.id);
          if (!document)
            fail('OBSERVATION_UNAVAILABLE', 'Frame layout changed; take a fresh observation');
          visible = visibleLayout(document, layout.strings, viewport);
        }
        await this.io.send(
          'Runtime.releaseObjectGroup',
          { objectGroup: 'coco-browser' },
          frame.sessionId,
        );
        const { nodes } = await this.io.send(
          'Accessibility.getFullAXTree',
          { frameId: frame.id },
          frame.sessionId,
        );
        const sensitiveNodes = new Set<string>();
        const hiddenNodes = new Set<string>();
        const byId = new Map<string, any>((nodes || []).map((node: any) => [node.nodeId, node]));
        for (const node of nodes || []) {
          let sensitive = (node.properties || []).some(
            (p: any) => p.name === 'protected' && p.value?.value === true,
          );
          // AX protects passwords, but plain-text OTP fields also expose their
          // value through child StaticText/InlineTextBox nodes.
          if (!sensitive && node.value && node.backendDOMNodeId) {
            const resolved = await this.io.send(
              'DOM.resolveNode',
              { backendNodeId: node.backendDOMNodeId, objectGroup: 'coco-browser' },
              frame.sessionId,
            );
            sensitive = await this.call({ objectId: resolved.object.objectId, frame }, 'sensitive');
          }
          if (!sensitive) continue;
          sensitiveNodes.add(node.nodeId);
          const descendants: string[] = [...(node.childIds || [])];
          while (descendants.length) {
            const id = descendants.pop()!;
            if (hiddenNodes.has(id)) continue;
            hiddenNodes.add(id);
            descendants.push(...(byId.get(id)?.childIds || []));
          }
        }
        lines.push(`Frame: ${frame.id} ${frame.url || ''}`);
        for (const node of nodes || []) {
          const role = node.role?.value || '';
          if (
            node.ignored ||
            hiddenNodes.has(node.nodeId) ||
            (visible && !visible.has(node.backendDOMNodeId)) ||
            role === 'InlineTextBox' ||
            !role ||
            (interactiveOnly && !interactive.has(role)) ||
            (!node.name?.value && !interactive.has(role))
          )
            continue;
          if (++count > 600) {
            lines.push('[truncated: 600 nodes; use find for a specific element]');
            return result(true);
          }
          const ref = `@${serial}-e${count}`;
          if (node.backendDOMNodeId)
            this.io.refs.set(ref, {
              backendNodeId: node.backendDOMNodeId,
              generation: this.io.generation,
              frame,
            });
          const props = Object.fromEntries(
            (node.properties || [])
              .filter((p: any) =>
                [
                  'checked',
                  'selected',
                  'disabled',
                  'expanded',
                  'readonly',
                  'required',
                  'focused',
                  'protected',
                  'url',
                ].includes(p.name),
              )
              .filter((p: any) => p.name !== 'url' || String(p.value?.value || '').length <= 4000)
              .map((p: any) => [p.name, p.value?.value]),
          );
          if (node.value) {
            props.value = sensitiveNodes.has(node.nodeId)
              ? '[redacted]'
              : String(node.value.value).slice(0, 1000);
          }
          const state = Object.keys(props).length ? ` ${JSON.stringify(props)}` : '';
          const name =
            (role === 'StaticText' ? visible?.get(node.backendDOMNodeId)?.text : undefined) ??
            node.name?.value ??
            '';
          const line = `${node.backendDOMNodeId ? ref : '-'} ${role} ${JSON.stringify(String(name).slice(0, 400))}${state}`;
          if (viewportOnly && chars + line.length + 1 > 11500) {
            lines.push(
              '[truncated: visible text budget; use targeted find/inspect for this viewport]',
            );
            return result(true);
          }
          lines.push(line);
          chars += line.length + 1;
        }
      } catch (error) {
        this.io.check();
        if (!transient(error)) throw error;
        warnings.push(`Frame ${frame.id} changed during snapshot`);
      }
    }
    return result();
  }
  private async topPoint(frame: Frame, local: Point, frames: Frame[]): Promise<Point> {
    if (!frame.parentId) return local;
    const parent = frames.find((f) => f.id === frame.parentId);
    if (!parent) fail('FRAME_UNAVAILABLE');
    const owner = await this.io.send('DOM.getFrameOwner', { frameId: frame.id }, parent.sessionId);
    const resolved = await this.io.send(
      'DOM.resolveNode',
      { backendNodeId: owner.backendNodeId, objectGroup: 'coco-browser' },
      parent.sessionId,
    );
    const element = { objectId: resolved.object.objectId, frame: parent };
    const geometry = await this.call(element, 'frame-geometry');
    const point = { x: geometry.x + local.x * geometry.sx, y: geometry.y + local.y * geometry.sy };
    if (!(await this.call(element, 'hit', point)))
      fail('ELEMENT_COVERED', 'Iframe is covered by another element');
    return this.topPoint(parent, point, frames);
  }
  async point(target: Target, scroll = true) {
    if (!target.ref) return { x: target.x!, y: target.y! };
    const element = await this.resolve(target.ref);
    const point = await this.call(element, 'point', scroll);
    return this.topPoint(element.frame, point, await this.safeFrames());
  }
  async assertEnabled(ref?: string) {
    if (ref && (await this.inspect(ref))?.disabled) fail('ELEMENT_DISABLED');
  }
  async click(target: Target, button = 'left', count = 1, modifiers?: string[]) {
    await this.assertEnabled(target.ref);
    for (let n = 1; n <= count; n++) {
      for (let attempt = 0; ; attempt++) {
        const point = await this.point(target);
        const fields = { ...point, button, modifiers: mask(modifiers) };
        try {
          await this.io.mouse({ ...fields, type: 'mousePressed', clickCount: n });
        } catch (error) {
          // This error is emitted by PointerMotion before mousePressed. It is
          // safe to reacquire a ref after hover-driven layout changes; never
          // replay an action after a native press was sent.
          if (
            target.ref &&
            attempt < 2 &&
            (error as { code?: string }).code === 'ELEMENT_CHANGED_DURING_MOVE'
          )
            continue;
          throw error;
        }
        await this.io.mouse({ ...fields, type: 'mouseReleased', clickCount: n });
        break;
      }
    }
    return { done: true };
  }
  async keypress(command: Extract<Command, { op: 'keypress' }>) {
    if (command.ref) await this.call(await this.resolve(command.ref), 'focus');
    for (const frame of await this.safeFrames()) {
      const focus = await this.query(frame, 'focus');
      if (focus?.focused && focus.sensitive) fail('SENSITIVE_INPUT');
      // Closed shadow roots do not expose activeElement to a document query.
      // The accessibility tree still identifies their focused control.
      if (focus?.focused) {
        const tree = await this.io.send(
          'Accessibility.getFullAXTree',
          { frameId: frame.id },
          frame.sessionId,
        );
        for (const node of tree.nodes || []) {
          if (
            !node.backendDOMNodeId ||
            !(node.properties || []).some(
              (p: any) => p.name === 'focused' && p.value?.value === true,
            )
          )
            continue;
          // AX marks both a document and its input as focused. DOM actions
          // apply only to elements; a Document has no ownerDocument.
          const described = await this.io.send(
            'DOM.describeNode',
            { backendNodeId: node.backendDOMNodeId },
            frame.sessionId,
          );
          if (described.node.nodeType !== 1) continue;
          const resolved = await this.io.send(
            'DOM.resolveNode',
            { backendNodeId: node.backendDOMNodeId, objectGroup: 'coco-browser' },
            frame.sessionId,
          );
          if (
            (await this.call({ objectId: resolved.object.objectId, frame }, 'inspect'))?.sensitive
          )
            fail('SENSITIVE_INPUT');
        }
      }
    }
    const key = command.key === 'Space' ? ' ' : command.key;
    const named: Record<string, number> = {
      Enter: 13,
      Tab: 9,
      Escape: 27,
      Backspace: 8,
      Delete: 46,
      ArrowUp: 38,
      ArrowDown: 40,
      ArrowLeft: 37,
      ArrowRight: 39,
      Home: 36,
      End: 35,
      PageUp: 33,
      PageDown: 34,
      ' ': 32,
    };
    const vk = named[key] || key.toUpperCase().charCodeAt(0);
    const fields = {
      key,
      code: /^[a-z]$/i.test(key)
        ? `Key${key.toUpperCase()}`
        : /^\d$/.test(key)
          ? `Digit${key}`
          : key === ' '
            ? 'Space'
            : key,
      windowsVirtualKeyCode: vk,
      modifiers: mask(command.modifiers),
    };
    const text =
      !fields.modifiers || fields.modifiers === 8
        ? key === 'Enter'
          ? '\r'
          : [...key].length === 1
            ? key
            : undefined
        : undefined;
    const editing: Record<string, string> = {
      a: 'selectAll',
      c: 'copy',
      x: 'cut',
      v: 'paste',
      z: 'undo',
      y: 'redo',
    };
    const shortcut = fields.modifiers & (2 | 4) ? editing[key.toLowerCase()] : undefined;
    const commands = shortcut
      ? [shortcut === 'undo' && fields.modifiers & 8 ? 'redo' : shortcut]
      : undefined;
    const modifierKeys: Record<
      string,
      { key: string; code: string; windowsVirtualKeyCode: number }
    > = {
      Alt: { key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18 },
      Control: { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 },
      Meta: { key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91 },
      Shift: { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 },
    };
    const held: string[] = [];
    let pressed = false;
    try {
      for (const modifier of new Set(command.modifiers || [])) {
        held.push(modifier);
        await this.io.send('Input.dispatchKeyEvent', {
          ...modifierKeys[modifier],
          type: 'rawKeyDown',
          modifiers: mask(held),
        });
      }
      pressed = true;
      await this.io.send('Input.dispatchKeyEvent', {
        ...fields,
        type: text ? 'keyDown' : 'rawKeyDown',
        ...(text ? { text } : {}),
        ...(commands ? { commands } : {}),
      });
    } finally {
      this.io.check();
      try {
        if (pressed) await this.io.send('Input.dispatchKeyEvent', { ...fields, type: 'keyUp' });
      } finally {
        while (held.length) {
          const modifier = held.pop()!;
          await this.io.send('Input.dispatchKeyEvent', {
            ...modifierKeys[modifier],
            type: 'keyUp',
            modifiers: mask(held),
          });
        }
      }
    }
    return { pressed: command.key, modifiers: command.modifiers || [] };
  }
  async run(command: Command): Promise<any> {
    switch (command.op) {
      case 'frames':
        return { frames: await this.safeFrames() };
      case 'find':
        return this.find(command.selector, command.frameId);
      case 'inspect':
        return this.inspect(command.ref);
      case 'click':
        return this.click(command, 'left', 1, command.modifiers);
      case 'double-click':
        return this.click(command, 'left', 2, command.modifiers);
      case 'right-click':
        return this.click(command, 'right', 1, command.modifiers);
      case 'hover':
        await this.io.mouse({ type: 'mouseMoved', ...(await this.point(command)) });
        return { done: true };
      case 'keypress':
        return this.keypress(command);
      case 'fill':
      case 'type': {
        const element = await this.resolve(command.ref);
        const point = await this.call(element, 'prepare-input', command.op === 'fill');
        await this.io.preview(
          'input',
          await this.topPoint(element.frame, point, await this.safeFrames()),
        );
        await this.call(element, 'check-focus');
        await this.io.send('Input.insertText', { text: command.text });
        return { done: true };
      }
      case 'select':
        return this.call(await this.resolve(command.ref), 'select', command.values);
      case 'check': {
        const before = await this.inspect(command.ref);
        if (before.checked === undefined) fail('NOT_CHECKABLE');
        if (before.disabled) fail('ELEMENT_DISABLED');
        if (before.checked !== command.checked) await this.click(command);
        const after = await this.inspect(command.ref);
        if (after.checked !== command.checked) fail('CHECK_STATE_UNCHANGED');
        return { checked: after.checked };
      }
      case 'scroll': {
        const deltaX =
          command.direction === 'right'
            ? command.pixels
            : command.direction === 'left'
              ? -command.pixels
              : 0;
        const deltaY =
          command.direction === 'down'
            ? command.pixels
            : command.direction === 'up'
              ? -command.pixels
              : 0;
        if (command.ref)
          return this.call(await this.resolve(command.ref), 'scroll', { deltaX, deltaY });
        const { cssLayoutViewport: v } = await this.io.send('Page.getLayoutMetrics');
        await this.io.mouse({
          type: 'mouseWheel',
          x: command.x ?? v.clientWidth / 2,
          y: command.y ?? v.clientHeight / 2,
          deltaX,
          deltaY,
        });
        return { done: true };
      }
      case 'drag': {
        // Resolve the destination first; scrollIntoView may move the source too.
        await this.point(command.to);
        const from = await this.point(command.from),
          to = await this.point(command.to, false);
        const modifiers = mask(command.modifiers);
        await this.io.send('Input.setInterceptDrags', { enabled: true });
        let pressed = false,
          last = from;
        try {
          await this.io.mouse({
            type: 'mousePressed',
            ...from,
            button: 'left',
            clickCount: 1,
            modifiers,
          });
          pressed = true;
          for (let n = 1; n <= command.steps; n++) {
            last = {
              x: from.x + ((to.x - from.x) * n) / command.steps,
              y: from.y + ((to.y - from.y) * n) / command.steps,
            };
            await this.io.mouse({
              type: 'mouseMoved',
              ...last,
              button: 'left',
              buttons: 1,
              modifiers,
            });
          }
          const data = this.io.dragData();
          if (data)
            for (const type of ['dragEnter', 'dragOver', 'drop'])
              await this.io.send('Input.dispatchDragEvent', { type, ...to, data, modifiers });
        } finally {
          this.io.check();
          try {
            if (pressed)
              await this.io.mouse({ type: 'mouseReleased', ...last, button: 'left', modifiers });
          } finally {
            await this.io.send('Input.setInterceptDrags', { enabled: false });
          }
        }
        return { done: true };
      }
      default:
        fail('UNSUPPORTED_COMMAND');
    }
  }
}
