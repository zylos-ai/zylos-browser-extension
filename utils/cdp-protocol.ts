import { z } from 'zod';

export const cdpBindingSchema = z
  .object({
    leaseId: z.string().uuid(),
    controlSessionId: z.string().uuid(),
    tabId: z.number().int().nonnegative(),
  })
  .strict();
export const cdpRequestSchema = z
  .object({
    type: z.literal('cdp-command'),
    id: z.string().uuid(),
    ...cdpBindingSchema.shape,
    deadline: z.number().finite(),
    method: z.string().min(1).max(100),
    params: z.record(z.unknown()).default({}),
    sessionId: z.string().max(200).optional(),
  })
  .strict();
export const cdpBindSchema = z
  .object({
    type: z.literal('cdp-bind'),
    id: z.string().uuid(),
    leaseId: z.string().uuid(),
    controlSessionId: z.string().uuid(),
    deadline: z.number().finite(),
  })
  .strict();
export type CdpRequest = z.infer<typeof cdpRequestSchema>;
export type CdpBind = z.infer<typeof cdpBindSchema>;
export type CdpBinding = z.infer<typeof cdpBindingSchema>;

// Browser-global, cookies, downloads, uploads and arbitrary raw CDP are not Agent tools.
// Runtime calls below come only from the pinned, filtered agent-browser engine.
export const CDP_METHODS = new Set([
  'Page.enable',
  'Page.disable',
  'Page.getFrameTree',
  'Page.getLayoutMetrics',
  'Page.navigate',
  'Page.reload',
  'Page.getNavigationHistory',
  'Page.navigateToHistoryEntry',
  'Page.setLifecycleEventsEnabled',
  'Page.captureScreenshot',
  'Page.createIsolatedWorld',
  'Runtime.enable',
  'Runtime.disable',
  'Runtime.evaluate',
  'Runtime.callFunctionOn',
  'Runtime.getProperties',
  'Runtime.releaseObject',
  'Runtime.releaseObjectGroup',
  'Runtime.runIfWaitingForDebugger',
  'Accessibility.enable',
  'Accessibility.disable',
  'Accessibility.getFullAXTree',
  'Accessibility.getPartialAXTree',
  'Accessibility.queryAXTree',
  'DOM.enable',
  'DOM.disable',
  'DOM.getDocument',
  'DOM.describeNode',
  'DOM.resolveNode',
  'DOM.getBoxModel',
  'DOM.getContentQuads',
  'DOM.scrollIntoViewIfNeeded',
  'DOM.focus',
  'DOM.querySelector',
  'DOM.querySelectorAll',
  'DOM.getAttributes',
  'DOM.getNodeForLocation',
  'DOM.requestNode',
  'DOM.getOuterHTML',
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  'Network.enable',
  'Network.disable',
]);
