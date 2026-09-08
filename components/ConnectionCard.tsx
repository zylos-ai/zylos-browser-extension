import { useEffect, useState } from 'react';
import type { Agent } from '../hooks/useAgent';
export function ConnectionCard({ agent }: { agent: Agent }) {
  const { state, request, reportError, clearError } = agent;
  const [url, setUrl] = useState(state.url);
  const [dirty, setDirty] = useState(false);
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!dirty) setUrl(state.url);
  }, [state.url, dirty]);
  useEffect(() => {
    if (state.ready) {
      setCode('');
      setDirty(false);
    }
  }, [state.ready]);
  return (
    <section id="pairing">
      <h2>{state.hasSavedConnection ? '配对设置' : '首次配对'}</h2>
      <p className="hint">配对一次，之后打开即可聊天。</p>
      <form
        id="pair-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (pending) return;
          clearError();
          setPending(true);
          try {
            await request({ type: 'pair', url: url.trim(), code });
          } catch (error) {
            reportError(error);
          } finally {
            setPending(false);
          }
        }}
      >
        <details className="advanced-connection">
          <summary>连接地址（高级）</summary>
          <label>
            Agent 地址
            <input
              id="url"
              type="url"
              value={url}
              onChange={(e) => {
                setDirty(true);
                setUrl(e.target.value);
              }}
              required
            />
          </label>
        </details>
        <label>
          一次性配对码
          <input
            id="code"
            type="password"
            autoComplete="off"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="只粘贴 code 的值，不含引号"
            required
          />
        </label>
        <button id="pair-submit" type="submit" disabled={pending || state.connecting}>
          {pending || state.connecting ? '正在连接…' : '配对并连接'}
        </button>
        <p className="hint">
          配对码 10 分钟内有效，且只能使用一次。配对成功后会自动保存，下次无需再填。
        </p>
      </form>
    </section>
  );
}
