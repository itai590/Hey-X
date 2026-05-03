import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import AdminLoginDialog from './components/AdminLoginDialog';
import { HEY_ADMIN_UNAUTHORIZED } from './apiClient';

const AdminAuthContext = createContext({
  /** Open the admin password dialog (e.g. lock icon before changing settings). */
  openAdminDialog: () => {},
});

export function useAdminAuth() {
  return useContext(AdminAuthContext);
}

export function AdminAuthProvider({ children }) {
  const [dialogOpen, setDialogOpen] = useState(false);

  const openAdminDialog = useCallback(() => setDialogOpen(true), []);

  useEffect(() => {
    const onNeedAuth = () => setDialogOpen(true);
    window.addEventListener(HEY_ADMIN_UNAUTHORIZED, onNeedAuth);
    return () => window.removeEventListener(HEY_ADMIN_UNAUTHORIZED, onNeedAuth);
  }, []);

  const handleLoggedIn = useCallback(() => {
    window.dispatchEvent(new CustomEvent('hey-admin-retry-pending'));
    setDialogOpen(false);
  }, []);

  const handleClose = useCallback(() => setDialogOpen(false), []);

  const value = { openAdminDialog };

  return (
    <AdminAuthContext.Provider value={value}>
      {children}
      <AdminLoginDialog open={dialogOpen} onClose={handleClose} onLoggedIn={handleLoggedIn} />
    </AdminAuthContext.Provider>
  );
}
