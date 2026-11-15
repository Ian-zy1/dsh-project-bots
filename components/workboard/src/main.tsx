import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import LocalWorkboard from './live/LocalWorkboard';
import { createDemoReader } from './data/demo/demoReader';
import './styles.css';

const scenario = new URLSearchParams(window.location.search).get('scenario') === 'error' ? 'error' : 'normal';
const reader = createDemoReader({ scenario });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {new URLSearchParams(window.location.search).get('demo') === '1' ? <App reader={reader} /> : <LocalWorkboard />}
  </StrictMode>,
);
