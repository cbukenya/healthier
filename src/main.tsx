import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { pickLocale, setLocale } from './i18n';
import './index.css';
import { applyMotionPrefs } from './hooks/useMotion';

// The browser's languages choose ours; ?lang= overrides them, e.g. ?lang=en-XA to check that every word is translatable.
const asked = new URLSearchParams(window.location.search).get('lang');
setLocale(pickLocale(asked ? [asked] : navigator.languages));
// Blur and twinkling as chosen in Settings › Animations, before the first paint.
applyMotionPrefs();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
