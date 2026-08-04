import React from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api';
import App from './App';
import './styles.css';

// Attach the API to window.mun so legacy components can find it
(window as any).mun = api;

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
