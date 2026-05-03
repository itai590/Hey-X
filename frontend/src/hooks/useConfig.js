import { useEffect, useState, useCallback, useRef } from 'react';
import { apiFetch } from '../apiClient';

const POLL_MS = 5000;

/**
 * @param {object} [opts]
 * @param {boolean} [opts.silent] — when true (background poll), do not touch loading spinner
 */
export default function useConfig() {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const isMounted = useRef(true);

  const loadConfig = useCallback(async (opts = {}) => {
    const silent = !!opts.silent;
    if (!silent) setLoading(true);
    try {
      const res = await apiFetch('/config', { method: 'GET', cache: 'no-store' });
      if (!isMounted.current) return;
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const data = await res.json();
      if (!isMounted.current) return;
      setConfig(data);
      setError(null);
    } catch (err) {
      if (!isMounted.current) return;
      console.error('Config fetch error:', err);
      setError('Could not load config');
    } finally {
      if (!isMounted.current) return;
      if (!silent) setLoading(false);
    }
  }, []);

  const updateConfig = useCallback(async (updates) => {
    try {
      const res = await apiFetch('/config', { method: 'PUT', json: updates });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err = new Error(body.error || `Status ${res.status}`);
        err.status = res.status;
        err.needsAdminAuth = body.needsAdminAuth === true;
        throw err;
      }
      const data = await res.json();
      setConfig(data);
      setError(null);
      return data;
    } catch (err) {
      console.error('Config update error:', err);
      setError(err.message);
      throw err;
    }
  }, []);

  useEffect(() => {
    isMounted.current = true;
    void loadConfig();
    const id = setInterval(() => {
      void loadConfig({ silent: true });
    }, POLL_MS);
    return () => {
      isMounted.current = false;
      clearInterval(id);
    };
  }, [loadConfig]);

  return { config, loading, error, updateConfig, reload: loadConfig };
}
