import React, { useCallback, useEffect, useRef, useState } from 'react';
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

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="md"
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
