import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RemotePanel } from '../../components/RemotePanel';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import '../../assets/styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing React root');
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <RemotePanel />
    </ErrorBoundary>
  </StrictMode>,
);
