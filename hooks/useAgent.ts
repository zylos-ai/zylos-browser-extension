import { useCallback, useEffect, useRef, useState } from 'react';
import {
  initialState,
  responseSchema,
  stateEventSchema,
  type PanelRequest,
} from '../utils/messages';

export function useAgent() {
  const [state, setState] = useState(initialState);
  const [error, setError] = useState('');
  const [windowId, setWindowId] = useState<number>();
  const revision = useRef(0);
  const mounted = useRef(false);
  const request = useCallback(async (message: PanelRequest) => {
    const started = revision.current;
    const response = responseSchema.parse(await chrome.runtime.sendMessage(message));
    if (!response.ok) throw new Error(response.error);
    if (mounted.current && started === revision.current) setState(response.value);
    return response.value;
  }, []);
  const reportError = useCallback(
    (error: unknown) => setError(error instanceof Error ? error.message : '操作失败，请重试'),
    [],
  );
  useEffect(() => {
    mounted.current = true;
    const listener = (message: unknown, sender: chrome.runtime.MessageSender) => {
      if (sender.id !== chrome.runtime.id) return;
      const event = stateEventSchema.safeParse(message);
      if (event.success) {
        revision.current++;
        setState(event.data.state);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    void request({ type: 'get-state' }).catch(reportError);
    void chrome.windows
      .getCurrent()
      .then((w) => {
        if (mounted.current) setWindowId(w.id);
      })
      .catch(reportError);
    return () => {
      mounted.current = false;
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, [request, reportError]);
  return {
    state,
    error: error || state.connectionError,
    windowId,
    request,
    reportError,
    clearError: () => setError(''),
  };
}
export type Agent = ReturnType<typeof useAgent>;
