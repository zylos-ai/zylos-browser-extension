import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RemotePanel } from '../../components/RemotePanel';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { LanguageProvider } from '../../components/LanguageProvider';
import '../../assets/styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing React root');
createRoot(root).render(
  <StrictMode>
    <LanguageProvider>
      <ErrorBoundary>
        <RemotePanel />
      </ErrorBoundary>
    </LanguageProvider>
  </StrictMode>,
);
