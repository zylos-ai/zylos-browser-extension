export type Point = {
  x: number;
  y: number;
  rect?: { x: number; y: number; width: number; height: number };
};
export type GrantedTab = { id: number; windowId: number; url: string; title: string };
export type Scope = {
  scope: 'task';
  phase: 'ready' | 'paused' | 'finished';
  windowId: number;
  sessionId: string;
  groupId: number | null;
  borrowedTabId?: number;
  tabId: number;
  tabIds: number[];
};
export type Cursor = { lease: GrantedTab; tabId: number; contextId: number; owner: string };
export type CdpResults = {
  'DOM.getNodeForLocation': { backendNodeId: number; frameId: string };
  'Runtime.callFunctionOn': {
    exceptionDetails?: { exception?: { description?: string } };
    result: { value: unknown };
  };
  'Runtime.evaluate': { exceptionDetails?: unknown; result?: { value?: unknown } };
  'Runtime.releaseObjectGroup': object;
  'DOM.resolveNode': { object: { objectId: string } };
  'Page.getFrameTree': { frameTree: { frame: { id: string } } };
  'Page.createIsolatedWorld': { executionContextId: number };
  'Page.captureScreenshot': { data: string };
  'Page.getLayoutMetrics': { cssLayoutViewport: { clientWidth: number; clientHeight: number } };
  'Accessibility.getFullAXTree': {
    nodes: {
      ignored?: boolean;
      role?: { value?: string };
      name?: { value?: string };
      backendDOMNodeId?: number;
    }[];
  };
  'Input.dispatchMouseEvent': object;
  'Input.dispatchKeyEvent': object;
  'Input.insertText': object;
};
