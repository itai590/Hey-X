import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import AdminLoginDialog from './components/AdminLoginDialog';
import { HEY_ADMIN_UNAUTHORIZED } from './apiClient';
import { getAdminToken, HEY_ADMIN_TOKEN_CHANGED } from './authStorage';

const AdminAuthContext = createContext({
  /** Open the admin password dialog (e.g. lock icon before changing settings). */
  openAdminDialog: () => {},
  /** True after a successful admin login this session (sessionStorage token). */
  hasAdminSession: false,
});

export function useAdminAuth() {
  return useContext(AdminAuthContext);
}

export function AdminAuthProvider({ children }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [hasAdminSession, setHasAdminSession] = useState(() => Boolean(getAdminToken().trim()));

  const openAdminDialog = useCallback(() => setDialogOpen(true), []);

  useEffect(() => {
    const onNeedAuth = () => {
      setHasAdminSession(false);
      setDialogOpen(true);
    };
    const onTokenChanged = (event) => {
      if (event && event.detail && typeof event.detail.hasToken === 'boolean') {
        setHasAdminSession(event.detail.hasToken);
        return;
      }
      setHasAdminSession(Boolean(getAdminToken().trim()));
    };
    window.addEventListener(HEY_ADMIN_UNAUTHORIZED, onNeedAuth);
    window.addEventListener(HEY_ADMIN_TOKEN_CHANGED, onTokenChanged);
    return () => {
      window.removeEventListener(HEY_ADMIN_UNAUTHORIZED, onNeedAuth);
      window.removeEventListener(HEY_ADMIN_TOKEN_CHANGED, onTokenChanged);
    };
  }, []);

  const handleLoggedIn = useCallback(() => {
    setHasAdminSession(true);
    window.dispatchEvent(new CustomEvent('hey-admin-retry-pending'));
    setDialogOpen(false);
  }, []);

  const handleClose = useCallback(() => setDialogOpen(false), []);

  const value = { openAdminDialog, hasAdminSession };

  return (
    <AdminAuthContext.Provider value={value}>
      {children}
      <AdminLoginDialog open={dialogOpen} onClose={handleClose} onLoggedIn={handleLoggedIn} />
    </AdminAuthContext.Provider>
  );
}
