import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from '@/renderer/app/App';
import { installGlobalErrorSink } from './global-error-sink';

installGlobalErrorSink();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
