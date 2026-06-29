import './consoleTimestamp';
import React from 'react';
import { createRoot } from 'react-dom/client';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import './index.css';
import App from './App';
import theme from './theme';
import { getAdminToken, setAdminToken } from './authStorage';

if (
  import.meta.env.VITE_DEMO_MODE === 'true'
  && !getAdminToken().trim()
  && import.meta.env.VITE_DEMO_ADMIN_TOKEN
) {
  setAdminToken(import.meta.env.VITE_DEMO_ADMIN_TOKEN);
}

const root = createRoot(document.getElementById('root'));
root.render(
  <ThemeProvider theme={theme}>
    <CssBaseline />
    <App />
  </ThemeProvider>
);
