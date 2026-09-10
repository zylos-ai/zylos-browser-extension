import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ExecutorPanel } from '../components/ExecutorPanel';
import { ErrorBoundary } from '../components/ErrorBoundary';
import '../assets/styles.css';

export function mount() {
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing React root');
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <ExecutorPanel />
      </ErrorBoundary>
    </StrictMode>,
  );
}
