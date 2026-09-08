import { Component, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (this.state.failed)
      return (
        <main role="alert">
          <h1>界面暂时不可用</h1>
          <p>你仍可点击 Chrome 调试提示中的“取消”接管浏览器。</p>
          <button onClick={() => location.reload()}>重新加载界面</button>
        </main>
      );
    return this.props.children;
  }
}
