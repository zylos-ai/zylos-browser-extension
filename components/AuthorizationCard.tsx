import { useState } from 'react';
import type { Agent } from '../hooks/useAgent';

export function AuthorizationCard({ agent }: { agent: Agent }) {
  const { state, request, windowId } = agent;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const authorization = state.authorization;
  if (!authorization) return null;
  const waiting = authorization.status === 'pending';
  const deciding = busy || authorization.status === 'approving';
  const messages = {
    pending: '允许 Agent 使用浏览器？',
    approving: '正在创建工作标签，确认后继续…',
    approved: '已授权专用工作标签',
    denied: '已取消，Agent 不会执行这次浏览器操作',
    cancelled: '本次浏览器授权已结束',
    expired: '授权请求已过期，未启动操作；需要时请重新发送需求',
    'resume-failed':
      '已授权，但续跑通知未确认送达。请查看最新回复，必要时发送“继续”；不要重复提交操作。',
  };
  const decide = async (allow: boolean) => {
    if (busy || !waiting || (allow && windowId === undefined)) return;
    setBusy(true);
    setError('');
    try {
      await request(
        allow
          ? { type: 'approve-authorization', id: authorization.id, windowId: windowId! }
          : { type: 'deny-authorization', id: authorization.id },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败，请重试');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="authorization-card" role="group" aria-label="浏览器授权" aria-busy={deciding}>
      <strong role="status">{messages[authorization.status]}</strong>
      {(waiting || authorization.status === 'approving') && (
        <>
          <p className="authorization-goal">{authorization.goal}</p>
          <p>
            将新建专用工作标签，允许 Agent 读取其中的网页内容和截图并执行操作；内容会发送给已连接的
            Agent。不会控制你的其他标签，随时可以停止。任务结束后自动关闭临时工作标签；需要保留的结果页请告诉
            Agent。
          </p>
          <div className="row">
            <button
              id="allow-browser"
              disabled={!state.ready || deciding || windowId === undefined}
              onClick={() => void decide(true)}
            >
              {deciding ? '正在授权…' : '允许并继续'}
            </button>
            <button
              className="secondary"
              disabled={!state.ready || deciding}
              onClick={() => void decide(false)}
            >
              取消
            </button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="authorization-error">
          {error}
        </p>
      )}
    </div>
  );
}
