import React, {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
} from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Box,
  CircularProgress,
} from '@mui/material';
import TerminalIcon from '@mui/icons-material/Terminal';
import RefreshIcon from '@mui/icons-material/Refresh';
import { apiFetch } from '../apiClient';
import { useAdminAuth } from '../AdminAuthProvider';

const DEFAULT_TAIL = 393216;
const LOG_SCROLL_STORAGE_KEY = 'hey-backend-logs-scroll';

function readSavedLogScroll() {
  try {
    const raw = sessionStorage.getItem(LOG_SCROLL_STORAGE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (
      typeof o.scrollTop !== 'number'
      || typeof o.atBottom !== 'boolean'
      || Number.isNaN(o.scrollTop)
    ) return null;
    return o;
  } catch {
    return null;
  }
}

function writeSavedLogScroll(el) {
  if (!el || el.scrollHeight <= 0) return;
  const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
  const atBottom = maxTop <= 4 || maxTop - el.scrollTop <= 4;
  try {
    sessionStorage.setItem(
      LOG_SCROLL_STORAGE_KEY,
      JSON.stringify({ scrollTop: el.scrollTop, atBottom }),
    );
  } catch {
    /* ignore quota / privacy mode */
  }
}

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 */
export default function BackendLogsDialog({ open, onClose }) {
  const { openAdminDialog } = useAdminAuth();
  const [text, setText] = useState('');
  const [info, setInfo] = useState('');
  const [detailPath, setDetailPath] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  /** After 401 + login, rerun fetch once while dialog stays open */
  const needRetryAfterAuthRef = useRef(false);
  /** Scrollable log viewport — tail-first by default; user scroll persists in sessionStorage */
  const logScrollRef = useRef(null);
  const scrollPersistRafRef = useRef(null);

  const applySavedScrollOrBottom = useCallback(() => {
    const el = logScrollRef.current;
    if (!el) return;
    const saved = readSavedLogScroll();
    const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
    if (saved && !saved.atBottom && maxTop > 0) {
      el.scrollTop = Math.min(Math.max(0, saved.scrollTop), maxTop);
    } else {
      el.scrollTop = el.scrollHeight;
    }
    writeSavedLogScroll(el);
  }, []);

  const load = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    setInfo('');
    try {
      const res = await apiFetch(`/admin/logs?maxBytes=${DEFAULT_TAIL}`);
      if (res.status === 401) {
        needRetryAfterAuthRef.current = true;
        openAdminDialog();
        setInfo('Admin password required — enter it in the lock dialog, then logs load automatically.');
        setText('');
        setDetailPath('');
        setTruncated(false);
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        needRetryAfterAuthRef.current = false;
        setInfo(typeof body.error === 'string' ? body.error : 'Failed to load logs');
        setText(typeof body.detail === 'string' ? body.detail : '');
        setDetailPath('');
        setTruncated(false);
        return;
      }
      needRetryAfterAuthRef.current = false;
      const msg = typeof body.message === 'string' ? body.message : '';
      setInfo(msg);
      setText(typeof body.text === 'string' ? body.text : '');
      setDetailPath(typeof body.path === 'string' ? body.path : '');
      setTruncated(!!body.truncated);
    } catch {
      setInfo('Network error — try again');
      setText('');
      setDetailPath('');
      setTruncated(false);
    } finally {
      setLoading(false);
    }
  }, [open, openAdminDialog]);

  /** Persist viewport scroll across refresh, dialog close/open, and fetches unless user pinned away from tail */
  useEffect(() => {
    const el = logScrollRef.current;
    if (!open || !el) return undefined;
    const onScroll = () => {
      if (scrollPersistRafRef.current != null) {
        cancelAnimationFrame(scrollPersistRafRef.current);
      }
      scrollPersistRafRef.current = requestAnimationFrame(() => {
        scrollPersistRafRef.current = null;
        writeSavedLogScroll(el);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (scrollPersistRafRef.current != null) {
        cancelAnimationFrame(scrollPersistRafRef.current);
        scrollPersistRafRef.current = null;
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      needRetryAfterAuthRef.current = false;
      return;
    }
    void load();
  }, [open, load]);

  useEffect(() => {
    const onRetry = () => {
      if (!open || !needRetryAfterAuthRef.current) return;
      needRetryAfterAuthRef.current = false;
      void load();
    };
    window.addEventListener('hey-admin-retry-pending', onRetry);
    return () => window.removeEventListener('hey-admin-retry-pending', onRetry);
  }, [open, load]);

  useLayoutEffect(() => {
    if (!open || loading) return;
    const id = requestAnimationFrame(() => {
      applySavedScrollOrBottom();
    });
    return () => cancelAnimationFrame(id);
  }, [open, loading, text, applySavedScrollOrBottom]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="md"
      TransitionProps={{
        onEntered: () => {
          if (!loading) {
            requestAnimationFrame(() => applySavedScrollOrBottom());
          }
        },
      }}
      slotProps={{
        paper: {
          sx: {
            bgcolor: 'rgba(22, 23, 26, 0.97)',
            border: '1px solid rgba(255,255,255,0.14)',
            maxHeight: '90vh',
          },
        },
      }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, color: 'white' }}>
        <TerminalIcon sx={{ color: '#90caf9' }} />
        Backend logs
      </DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1, minHeight: 280 }}>
        {info && (
          <Typography variant="body2" sx={{ color: 'grey.400' }}>
            {info}
          </Typography>
        )}
        {detailPath ? (
          <Typography variant="caption" sx={{ color: 'grey.500', fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' }}>
            {detailPath}
            {truncated ? ' · showing tail only' : ''}
          </Typography>
        ) : null}
        <Box sx={{ position: 'relative', flex: 1, minHeight: 200 }}>
          {loading && (
            <Box
              sx={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                bgcolor: 'rgba(0,0,0,0.25)',
                zIndex: 1,
                borderRadius: 1,
              }}
            >
              <CircularProgress size={36} sx={{ color: '#90caf9' }} />
            </Box>
          )}
          <Box
            ref={logScrollRef}
            component="pre"
            sx={{
              m: 0,
              p: 1.5,
              height: 'min(55vh, 420px)',
              overflow: 'auto',
              bgcolor: 'rgba(0,0,0,0.45)',
              borderRadius: 1,
              border: '1px solid rgba(255,255,255,0.08)',
              color: '#e0e0e0',
              fontSize: '0.72rem',
              lineHeight: 1.45,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {text || (loading ? '' : '—')}
          </Box>
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
        <Button
          startIcon={<RefreshIcon />}
          onClick={() => void load()}
          disabled={loading}
          sx={{ color: '#90caf9' }}
        >
          Refresh
        </Button>
        <Button onClick={onClose} sx={{ color: 'grey.400' }}>
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
}
