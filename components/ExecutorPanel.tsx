import { useEffect, useState } from 'react';
import {
  initialPlatformState,
  platformStateSchema,
  platformWeb,
  type PlatformState,
} from '../utils/platform';

export function ExecutorPanel() {
  const [state, setState] = useState<PlatformState>(initialPlatformState);
  async function request(message: unknown) {
    try {
      const r = await chrome.runtime.sendMessage(message);
      if (r.ok) setState(platformStateSchema.parse(r.value));
      else setState((s) => ({ ...s, error: r.error || '操作失败' }));
    } catch {
      setState((s) => ({ ...s, error: '插件服务不可用，请重新打开面板' }));
    }
  }
  useEffect(() => {
    const listener = (m: unknown) => {
      if (
        m &&
        typeof m === 'object' &&
        'type' in m &&
        m.type === 'platform-updated' &&
        'state' in m
      ) {
        const parsed = platformStateSchema.safeParse(m.state);
        if (parsed.success) setState(parsed.data);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    void request({ type: 'platform-state' });
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);
  const task = state.authRequired ? null : state.task;
  const action = (action: string) =>
    void request({ type: 'platform-decide', action, taskId: task?.id });
  return (
    <div className="app">
      <header>
        <h1 className="brand">coco</h1>
        <span className="pill">
          {state.authRequired ? '需要重新连接' : state.connected ? '浏览器已连接' : '浏览器离线'}
        </span>
      </header>
      {state.error && <p role="alert">{state.error}</p>}
      {!state.user || state.authRequired ? (
        <section>
          <h2>{state.authRequired ? '重新连接 OpenMAX' : '连接 OpenMAX'}</h2>
          {state.authRequired && state.user && <p>之前连接：{state.user.display_name}</p>}
          <p>前往 OpenMAX 个人主页确认账号，不需要选择或绑定 Agent。浏览器任务仍在聊天中授权。</p>
          {state.loginPending && (
            <p role="status">请在 OpenMAX 个人主页确认账号，无须返回此面板确认。</p>
          )}
          <button disabled={state.busy} onClick={() => void request({ type: 'platform-login' })}>
            {state.authRequired ? '重新连接' : '登录并连接'}
          </button>
        </section>
      ) : (
        <section>
          <p>{state.user.display_name}</p>
          <button className="link" onClick={() => void chrome.tabs.create({ url: platformWeb })}>
            打开 OpenMAX 对话
          </button>
        </section>
      )}
      {task?.state === 'preparing' && <p role="status">正在准备浏览器，无须再次授权。</p>}
      {task?.state === 'running' && (
        <section>
          <h2>{state.hasWorkTab ? 'Agent 正在操作' : '已授权，等待 Agent 打开网页'}</h2>
          {state.hasWorkTab ? (
            <button className="link" onClick={() => void request({ type: 'platform-reveal' })}>
              查看工作标签
            </button>
          ) : (
            <p>目标网站打开后，工作标签会出现在聊天页旁边。</p>
          )}
          <button onClick={() => action('stop')}>停止</button>
        </section>
      )}
      {task?.state === 'waiting_user' && (
        <section>
          <h2>等待你操作</h2>
          <p>
            {state.hasWorkTab
              ? '请在工作标签完成登录或确认，再回到 OpenMAX 对话点击继续。'
              : '请查看 OpenMAX 对话中的提示，确认后再继续。'}
          </p>
          {state.hasWorkTab && (
            <button onClick={() => void request({ type: 'platform-reveal' })}>打开工作标签</button>
          )}
          <button className="link" onClick={() => action('stop')}>
            停止
          </button>
        </section>
      )}
      {task?.state === 'closed' && (
        <p>
          {task.cleanup_state === 'unknown' || task.cleanup_state === 'partial'
            ? '任务已停止，请检查遗留工作标签。'
            : '本次任务已结束，结果在 OpenMAX 对话中。'}
        </p>
      )}
      {state.user && (
        <footer>
          <button
            disabled={state.busy}
            className="link"
            onClick={() => void request({ type: 'platform-disconnect' })}
          >
            {state.authRequired ? '移除失效连接' : '退出插件账号'}
          </button>
        </footer>
      )}
    </div>
  );
}
