import { Component, type ReactNode } from 'react';
import { useI18n } from './LanguageProvider';
import { reportPanelDiagnostic } from '../utils/diagnostics-panel';
import { safeError } from '../utils/diagnostics-schema';

function ErrorFallback() {
  const { t } = useI18n();
  return (
    <main className="error-page" role="alert">
      <h1>{t('errorTitle')}</h1>
      <p>{t('errorDescription')}</p>
      <button className="btn btn-primary" onClick={() => location.reload()}>
        {t('reloadInterface')}
      </button>
    </main>
  );
}
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: Error) {
    reportPanelDiagnostic({ event: 'runtime-error', level: 'error', ...safeError(error) });
  }
  override render() {
    return this.state.failed ? <ErrorFallback /> : this.props.children;
  }
}
