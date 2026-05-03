import React from 'react';
import { BrowserRouter as Router, Routes, Route, useParams } from "react-router-dom";
import Document from './components/Document';
import Home from './Home';
import mainContext from './context';
import config from './config';
import { AdminAuthProvider } from './AdminAuthProvider';

export default function App() {
  const context = {};

  const rawBase = import.meta.env.BASE_URL || '/';
  const basename =
    rawBase && rawBase !== '/'
      ? rawBase.replace(/\/$/, '')
      : undefined;

  return (
    <mainContext.Provider value={context}>
      <AdminAuthProvider>
        <Router basename={basename}>
          <Routes>
            <Route path="/:id" element={<DocumentRoute />} />
            <Route path="/" element={<HomeOrDocument />} />
          </Routes>
        </Router>
      </AdminAuthProvider>
    </mainContext.Provider>
  );
}

function HomeOrDocument() {
  const host = getHost();
  if (host) {
    return <Document path={config.mainPath} id={host} />;
  }
  return <Home />;
}

function DocumentRoute() {
  const { id } = useParams();
  const host = getHost();
  const documentId = host || id;
  return <Document path={config.mainPath} id={documentId} />;
}

function getHost() {
  const { extraDomains = [] } = config;
  const list = [...extraDomains, 'localhost', '127.0.0.1'];
  const url = new URL(window.location.href);
  for (const domain of list) {
    if (url.hostname.endsWith(domain)) {
      return url.hostname.replace(new RegExp(`[.]*${domain}`), "");
    }
  }
}
