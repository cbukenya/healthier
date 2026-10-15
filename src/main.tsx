import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { pickLocale, setLocale } from './i18n';
import './index.css';

// The browser's languages choose ours; ?lang= overrides them, e.g. ?lang=en-XA to check that every word is translatable.
const asked = new URLSearchParams(window.location.search).get('lang');
setLocale(pickLocale(asked ? [asked] : navigator.languages));

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
