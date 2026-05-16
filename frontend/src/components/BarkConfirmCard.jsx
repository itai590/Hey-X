import React, { useEffect, useRef, useState } from 'react';
import { Box, IconButton, Typography, CircularProgress } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import BlockIcon from '@mui/icons-material/Block';
import { apiUrl } from '../apiBase';
import { apiFetch } from '../apiClient';

const AUTO_DISMISS_MS = 30_000;

/**
 * A dismissible card that appears when a new bark is detected.
 * Shows an audio player and lets the user confirm the bark or mark it as a false positive.
 * Auto-dismisses after 30 s; the clip stays in the training inbox for later review.
 *
 * @param {{ clipId: string, messageId: string, onDismiss: () => void }} props
 */
export default function BarkConfirmCard({ clipId, messageId, onDismiss }) {
  const [actionsOpen, setActionsOpen] = useState(false);
  const [status, setStatus] = useState('idle'); // idle | loading | done | error
  const [errorMsg, setErrorMsg] = useState('');

  // Countdown for auto-dismiss
  const [remaining, setRemaining] = useState(AUTO_DISMISS_MS / 1000);
  const autoTimer = useRef(null);
  const countdownInterval = useRef(null);

  // Touch tracking for swipe-left gesture
  const touchStartX = useRef(null);

  useEffect(() => {
    autoTimer.current = setTimeout(onDismiss, AUTO_DISMISS_MS);
    countdownInterval.current = setInterval(() => {
      setRemaining((r) => Math.max(0, r - 1));
    }, 1000);
    return () => {
      clearTimeout(autoTimer.current);
      clearInterval(countdownInterval.current);
    };
  }, [onDismiss]);

  const cancelAutoDismiss = () => {
    clearTimeout(autoTimer.current);
    clearInterval(countdownInterval.current);
    setRemaining(null);
  };

  const promote = async (label) => {
    cancelAutoDismiss();
    setStatus('loading');
    try {
      const res = await apiFetch(`/training/inbox/${clipId}/promote`, {
        method: 'POST',
        json: { label },
      });
      if (res.ok) {
        setStatus('done');
        setTimeout(onDismiss, 600);
      } else if (res.status === 401) {
        setStatus('error');
        setErrorMsg('Admin login required to label clips.');
      } else {
        const body = await res.json().catch(() => ({}));
        setStatus('error');
        setErrorMsg(body.error || `Error ${res.status}`);
      }
    } catch {
      setStatus('error');
      setErrorMsg('Network error — clip stays in inbox.');
    }
  };

  const handleTouchStart = (e) => {
    touchStartX.current = e.touches[0].clientX;
  };
  const handleTouchEnd = (e) => {
    if (touchStartX.current === null) return;
    const dx = touchStartX.current - e.changedTouches[0].clientX;
    if (dx > 50) setActionsOpen(true); // swipe left
    touchStartX.current = null;
  };

  return (
    <Box
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      sx={{
        position: 'relative',
        bgcolor: 'background.paper',
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 2,
        boxShadow: 4,
        p: 1.5,
        width: 300,
        maxWidth: '90vw',
        overflow: 'hidden',
      }}
    >
      {/* Header row */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary' }}>
          New bark detected
          {remaining !== null && (
            <Typography component="span" variant="caption" sx={{ ml: 0.5, color: 'text.disabled' }}>
              ({remaining}s)
            </Typography>
          )}
        </Typography>
        <Box sx={{ display: 'flex', gap: 0.5 }}>
          {/* Expand actions toggle (desktop) */}
          <IconButton
            size="small"
            title="Show actions"
            onClick={() => { cancelAutoDismiss(); setActionsOpen((o) => !o); }}
          >
            <MoreHorizIcon fontSize="small" />
          </IconButton>
          <IconButton size="small" title="Dismiss" onClick={onDismiss}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>
      </Box>

      {/* Audio player */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        controls
        src={apiUrl(`/training/inbox/${clipId}/audio`)}
        style={{ width: '100%', height: 36 }}
        onPlay={cancelAutoDismiss}
      />

      {/* Action buttons — revealed by ⋯ or swipe-left */}
      {actionsOpen && status === 'idle' && (
        <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
          <Box
            component="button"
            onClick={() => promote('bark')}
            sx={{
              flex: 1, py: 0.75, border: '1px solid', borderColor: 'success.main',
              borderRadius: 1, bgcolor: 'transparent', color: 'success.main',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0.5,
              fontSize: '0.8rem', fontWeight: 600,
              '&:hover': { bgcolor: 'success.main', color: '#fff' },
            }}
          >
            <CheckCircleOutlineIcon sx={{ fontSize: 16 }} />
            Confirm bark
          </Box>
          <Box
            component="button"
            onClick={() => promote('not_bark')}
            sx={{
              flex: 1, py: 0.75, border: '1px solid', borderColor: 'error.main',
              borderRadius: 1, bgcolor: 'transparent', color: 'error.main',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0.5,
              fontSize: '0.8rem', fontWeight: 600,
              '&:hover': { bgcolor: 'error.main', color: '#fff' },
            }}
          >
            <BlockIcon sx={{ fontSize: 16 }} />
            False positive
          </Box>
        </Box>
      )}

      {status === 'loading' && (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 1 }}>
          <CircularProgress size={20} />
        </Box>
      )}

      {status === 'done' && (
        <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'success.main', textAlign: 'center' }}>
          Labeled — thanks!
        </Typography>
      )}

      {status === 'error' && (
        <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'error.main', textAlign: 'center' }}>
          {errorMsg}
        </Typography>
      )}
    </Box>
  );
}
