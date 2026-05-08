import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Box, Switch, Slider, Typography, IconButton, Checkbox,
  Button, Collapse, Tooltip, Snackbar, Alert, Paper, TextField, Tabs, Tab,
} from '@mui/material';
import useMediaQuery from '@mui/material/useMediaQuery';
import SettingsIcon from '@mui/icons-material/Settings';
import LockIcon from '@mui/icons-material/Lock';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import MicIcon from '@mui/icons-material/Mic';
import MicOffIcon from '@mui/icons-material/MicOff';
import DeleteIcon from '@mui/icons-material/Delete';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import TerminalIcon from '@mui/icons-material/Terminal';
import HeadphonesOutlinedIcon from '@mui/icons-material/HeadphonesOutlined';
import ErrorBanner from './components/ErrorBanner';
import BackendLogsDialog from './components/BackendLogsDialog';
import useMessages from './hooks/useMessages';
import useConfig from './hooks/useConfig';
import { apiUrl, trainingListenPageUrl } from './apiBase';
import { apiFetch } from './apiClient';
import { useAdminAuth } from './AdminAuthProvider';
import { formatBarkTimestamp } from './formatDisplayTime';

const DEFAULTS = {
  BARK_CONFIDENCE_THRESHOLD: 0.25,
  MIN_RMS_AMPLITUDE: 0.3,
  DETECTION_THRESHOLD: 1,
  AGGREGATION_TIMER: 60,
  MIC_MUTED: false,
  DOG_NAME: '',
  /** Filename under React `public/` (must match backend config default). */
  DOG_IMAGE_FILE: 'Sheldon.jpeg',
};

/** Join `BASE_URL` and a public asset filename (defensive if `base` lacks a trailing slash). */
function publicAssetUrl(filename) {
  const name = String(filename ?? '').trim().replace(/^\/+/, '');
  if (!name) return import.meta.env.BASE_URL;
  let base = import.meta.env.BASE_URL || '/';
  if (base !== '/' && !base.endsWith('/')) base = `${base}/`;
  return `${base}${encodeURI(name)}`;
}

/**
 * Only used if `DOG_IMAGE_FILE` fails to load (404, etc.). Not a shipped asset — your real
 * photo lives in `public/` (e.g. `Sheldon.jpeg`).
 */
const DOG_IMAGE_FALLBACK =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">'
    + '<rect width="200" height="200" fill="#5d4037"/>'
    + '<text x="100" y="112" text-anchor="middle" font-size="64" dominant-baseline="middle">🐶</text>'
    + '</svg>',
  );

// Slider steps land on values like 0.030000000000000002 — equality on float defaults misfires.
const nearlyEquals = (a, b) => Math.abs(a - b) < 1e-6;

export default function Home() {
  const { messages, error, reload: reloadMessages } = useMessages();
  const { config, loading: configLoading, updateConfig, reload: reloadConfig } = useConfig();
  const { openAdminDialog, hasAdminSession } = useAdminAuth();

  const pendingConfigRef = useRef(null);
  const pendingDeleteRef = useRef(false);

  /** When you return to the tab or refocus the window, pull the latest barks and config (no F5). */
  useEffect(() => {
    let coalesce = null;
    const onRefresh = () => {
      clearTimeout(coalesce);
      coalesce = setTimeout(() => {
        void reloadMessages();
        void reloadConfig({ silent: true });
      }, 150);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') onRefresh();
    };
    window.addEventListener('focus', onRefresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(coalesce);
      window.removeEventListener('focus', onRefresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reloadMessages, reloadConfig]);

  /** True when the latest clip is at/above the noise floor and its age is under AGGREGATION_TIMER (same as grouping window). */
  const [aboveNoiseFloor, setAboveNoiseFloor] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  /** 0 = mic/AI/signal, 1 = alert count + grouping window, 2 = browser tab title */
  const [settingsTab, setSettingsTab] = useState(0);
  const [selected, setSelected] = useState(new Set());
  const [expandedMessages, setExpandedMessages] = useState(new Set());
  const [snack, setSnack] = useState({ open: false, message: '', severity: 'success' });

  // Local editable copies of config values (only committed on blur/change)
  const [localThreshold, setLocalThreshold] = useState(DEFAULTS.BARK_CONFIDENCE_THRESHOLD);
  const [localRms, setLocalRms] = useState(DEFAULTS.MIN_RMS_AMPLITUDE);
  const [localAiEnabled, setLocalAiEnabled] = useState(true);
  const [localDetThreshold, setLocalDetThreshold] = useState(DEFAULTS.DETECTION_THRESHOLD);
  const [localAggrTimer, setLocalAggrTimer] = useState(DEFAULTS.AGGREGATION_TIMER);
  const [localMicMuted, setLocalMicMuted] = useState(DEFAULTS.MIC_MUTED);
  const [localDogName, setLocalDogName] = useState(DEFAULTS.DOG_NAME);
  const [dogImageFailed, setDogImageFailed] = useState(false);

  /** CSS-only landscape queries miss some iOS Safari viewports; matchMedia is reliable. */
  const mqShortHeight = useMediaQuery('(max-height: 520px)', { noSsr: true });
  const mqLandscapeNarrow = useMediaQuery('(orientation: landscape) and (max-width: 960px)', { noSsr: true });
  const isMobile = useMediaQuery('(max-width: 600px)', { noSsr: true });
  /** Short but wide: landscape phones even when orientation / height media queries lie */
  const mqWideShort = useMediaQuery('(max-height: 560px) and (min-width: 480px)', { noSsr: true });
  const compactHeaderRow = mqLandscapeNarrow || mqWideShort;
  const tightTopBar = compactHeaderRow || mqShortHeight;

  const dogImageFile = config?.DOG_IMAGE_FILE || DEFAULTS.DOG_IMAGE_FILE;
  const dogImageSrc = publicAssetUrl(dogImageFile);

  useEffect(() => {
    setDogImageFailed(false);
  }, [dogImageSrc]);

  useEffect(() => {
    if (config) {
      setLocalThreshold(config.BARK_CONFIDENCE_THRESHOLD);
      setLocalRms(config.MIN_RMS_AMPLITUDE);
      setLocalAiEnabled(config.AI_DETECTION_ENABLED);
      setLocalDetThreshold(config.DETECTION_THRESHOLD ?? DEFAULTS.DETECTION_THRESHOLD);
      setLocalAggrTimer(config.AGGREGATION_TIMER ?? 60);
      if (config.MIC_MUTED !== undefined) {
        setLocalMicMuted(!!config.MIC_MUTED);
      }
      if (config.DOG_NAME !== undefined) {
        setLocalDogName(String(config.DOG_NAME).trim());
      }
    }
  }, [config]);

  useEffect(() => {
    const trimmed =
      config?.DOG_NAME != null ? String(config.DOG_NAME).trim() : '';
    document.title = trimmed ? `Hey ${trimmed}` : 'Hey';
  }, [config?.DOG_NAME]);

  /** Same window as server AGGREGATION_TIMER: how long the last RMS sample counts as "recent" for the ring. */
  const rmsRecentWindowSec = useRef(DEFAULTS.AGGREGATION_TIMER);
  useEffect(() => {
    rmsRecentWindowSec.current = config?.AGGREGATION_TIMER ?? DEFAULTS.AGGREGATION_TIMER;
  }, [config?.AGGREGATION_TIMER]);

  // Poll /api/presence for above-noise-floor ring
  useEffect(() => {
    let active = true;

    async function poll() {
      try {
        const res = await fetch(apiUrl('/presence'));
        if (!res.ok) return;
        const data = await res.json();
        if (!active) return;

        if (data.micMuted != null) {
          setLocalMicMuted(!!data.micMuted);
        }
        if (data.micMuted) {
          setAboveNoiseFloor(false);
        } else if (data.lastRms != null && data.lastRmsTime && data.serverTime) {
          const rmsAgeSec = (new Date(data.serverTime) - new Date(data.lastRmsTime)) / 1000;
          const win = rmsRecentWindowSec.current;
          setAboveNoiseFloor(rmsAgeSec < win && data.lastRmsAboveFloor === true);
        } else if (!data.micMuted) {
          setAboveNoiseFloor(false);
        }
      } catch { /* ignore */ }
    }

    poll();
    const id = setInterval(poll, 2000);
    return () => { active = false; clearInterval(id); };
  }, []);

  const showSnack = useCallback((message, severity = 'success') => {
    setSnack({ open: true, message, severity });
  }, []);

  /**
   * @param {Record<string, unknown>} updates
   * @param {{ suppressSuccessSnack?: boolean }} [opts]
   * @returns {Promise<boolean>} true if saved, false if 401 (admin password required)
   */
  const handleConfigSave = useCallback(async (updates, opts = {}) => {
    const { suppressSuccessSnack } = opts;
    try {
      await updateConfig(updates);
      pendingConfigRef.current = null;
      if (!suppressSuccessSnack) showSnack('Settings saved');
      return true;
    } catch (err) {
      if (err && err.status === 401) {
        pendingConfigRef.current = updates;
        showSnack('Admin password required — tap the lock icon', 'warning');
        return false;
      }
      if (!suppressSuccessSnack) showSnack('Failed to save settings', 'error');
      throw err;
    }
  }, [updateConfig, showSnack]);

  const handleBulkDelete = useCallback(async () => {
    if (selected.size === 0) return;
    try {
      const res = await apiFetch('/messages', {
        method: 'DELETE',
        json: { ids: [...selected] },
      });
      if (res.status === 401) {
        pendingDeleteRef.current = true;
        showSnack('Admin password required — tap the lock icon', 'warning');
        return;
      }
      if (!res.ok) throw new Error('Delete failed');
      const data = await res.json();
      showSnack(`Deleted ${data.deleted} bark event${data.deleted !== 1 ? 's' : ''}`);
      setSelected(new Set());
      reloadMessages();
    } catch {
      showSnack('Failed to delete', 'error');
    }
  }, [selected, reloadMessages, showSnack]);

  useEffect(() => {
    const onRetry = () => {
      const pending = pendingConfigRef.current;
      if (pending) {
        pendingConfigRef.current = null;
        void handleConfigSave(pending);
        return;
      }
      if (pendingDeleteRef.current) {
        pendingDeleteRef.current = false;
        void handleBulkDelete();
      }
    };
    window.addEventListener('hey-admin-retry-pending', onRetry);
    return () => window.removeEventListener('hey-admin-retry-pending', onRetry);
  }, [handleConfigSave, handleBulkDelete]);

  const handleMicToggle = async () => {
    const next = !localMicMuted;
    setLocalMicMuted(next);
    try {
      const ok = await handleConfigSave({ MIC_MUTED: next }, { suppressSuccessSnack: true });
      if (ok === false) {
        setLocalMicMuted(!next);
        return;
      }
      showSnack(next ? 'Microphone off - not recording' : 'Microphone on', 'success');
    } catch {
      setLocalMicMuted(!next);
      showSnack('Failed to update microphone', 'error');
    }
  };

  const handleAiToggle = async (e) => {
    const val = e.target.checked;
    const prev = !val;
    setLocalAiEnabled(val);
    const ok = await handleConfigSave({ AI_DETECTION_ENABLED: val }, { suppressSuccessSnack: true });
    if (ok === false) setLocalAiEnabled(prev);
  };

  const handleThresholdCommit = async (_e, val) => {
    const prev = config?.BARK_CONFIDENCE_THRESHOLD ?? DEFAULTS.BARK_CONFIDENCE_THRESHOLD;
    setLocalThreshold(val);
    const ok = await handleConfigSave({ BARK_CONFIDENCE_THRESHOLD: val }, { suppressSuccessSnack: true });
    if (ok === false) setLocalThreshold(prev);
    else if (ok) showSnack('Settings saved');
  };

  const handleRmsCommit = async (_e, val) => {
    const prev = config?.MIN_RMS_AMPLITUDE ?? DEFAULTS.MIN_RMS_AMPLITUDE;
    setLocalRms(val);
    const ok = await handleConfigSave({ MIN_RMS_AMPLITUDE: val }, { suppressSuccessSnack: true });
    if (ok === false) setLocalRms(prev);
    else if (ok) showSnack('Settings saved');
  };

  const handleDetThresholdCommit = async (_e, val) => {
    const prev = config?.DETECTION_THRESHOLD ?? DEFAULTS.DETECTION_THRESHOLD;
    setLocalDetThreshold(val);
    const ok = await handleConfigSave({ DETECTION_THRESHOLD: val }, { suppressSuccessSnack: true });
    if (ok === false) setLocalDetThreshold(prev);
    else if (ok) showSnack('Settings saved');
  };

  const handleAggrTimerCommit = async (_e, val) => {
    const prev = config?.AGGREGATION_TIMER ?? DEFAULTS.AGGREGATION_TIMER;
    setLocalAggrTimer(val);
    const ok = await handleConfigSave({ AGGREGATION_TIMER: val }, { suppressSuccessSnack: true });
    if (ok === false) setLocalAggrTimer(prev);
    else if (ok) showSnack('Settings saved');
  };

  const handleDogNameBlur = async () => {
    const t = localDogName.trim();
    const current =
      config?.DOG_NAME != null ? String(config.DOG_NAME).trim() : '';
    if (t === current) return;
    setLocalDogName(t);
    try {
      const ok = await handleConfigSave({ DOG_NAME: t }, { suppressSuccessSnack: true });
      if (ok === false) setLocalDogName(current);
      else if (ok) showSnack('Settings saved');
    } catch {
      setLocalDogName(current);
    }
  };

  const handleReset = async (key) => {
    const val = DEFAULTS[key];
    if (key === 'BARK_CONFIDENCE_THRESHOLD') {
      const prev = config?.BARK_CONFIDENCE_THRESHOLD ?? DEFAULTS.BARK_CONFIDENCE_THRESHOLD;
      setLocalThreshold(val);
      const ok = await handleConfigSave({ [key]: val }, { suppressSuccessSnack: true });
      if (ok === false) setLocalThreshold(prev);
      else if (ok) showSnack('Settings saved');
      return;
    }
    if (key === 'MIN_RMS_AMPLITUDE') {
      const prev = config?.MIN_RMS_AMPLITUDE ?? DEFAULTS.MIN_RMS_AMPLITUDE;
      setLocalRms(val);
      const ok = await handleConfigSave({ [key]: val }, { suppressSuccessSnack: true });
      if (ok === false) setLocalRms(prev);
      else if (ok) showSnack('Settings saved');
      return;
    }
    if (key === 'DETECTION_THRESHOLD') {
      const prev = config?.DETECTION_THRESHOLD ?? DEFAULTS.DETECTION_THRESHOLD;
      setLocalDetThreshold(val);
      const ok = await handleConfigSave({ [key]: val }, { suppressSuccessSnack: true });
      if (ok === false) setLocalDetThreshold(prev);
      else if (ok) showSnack('Settings saved');
      return;
    }
    if (key === 'AGGREGATION_TIMER') {
      const prev = config?.AGGREGATION_TIMER ?? DEFAULTS.AGGREGATION_TIMER;
      setLocalAggrTimer(val);
      const ok = await handleConfigSave({ [key]: val }, { suppressSuccessSnack: true });
      if (ok === false) setLocalAggrTimer(prev);
      else if (ok) showSnack('Settings saved');
      return;
    }
    if (key === 'DOG_NAME') {
      const prev = config?.DOG_NAME != null ? String(config.DOG_NAME).trim() : DEFAULTS.DOG_NAME;
      setLocalDogName(val);
      const ok = await handleConfigSave({ [key]: val }, { suppressSuccessSnack: true });
      if (ok === false) setLocalDogName(prev);
      else if (ok) showSnack('Settings saved');
    }
  };

  // --- Selection ---
  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === messages.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(messages.map((m) => m.id)));
    }
  };

  const sorted = [...messages].sort(
    (a, b) => new Date(b.update_time || b.create_time) - new Date(a.update_time || a.create_time)
  );

  const shouldCollapseMessage = useCallback((text) => {
    if (typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    return trimmed.length > 110 || trimmed.includes('| top5:') || trimmed.startsWith('rms=');
  }, []);

  const toggleMessageExpanded = useCallback((messageId) => {
    setExpandedMessages((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }, []);

  return (
    <Box
      className="fill"
      sx={{
        px: tightTopBar ? { xs: 1.25, sm: 1.75 } : { xs: 2, sm: 2.5, md: 3 },
        py: tightTopBar ? 0.75 : 2,
        backgroundColor: 'transparent',
        minHeight: '100vh',
        '@supports (height: 100dvh)': {
          minHeight: '100dvh',
        },
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        overflowY: 'auto',
        fontFamily: 'sans-serif',
        position: 'relative',
        boxSizing: 'border-box',
      }}
    >
      {/* Settings gear — top-right */}
      <Box
        sx={{
          position: 'absolute',
          top: 12,
          right: 12,
          zIndex: 10,
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          flexWrap: 'wrap',
          justifyContent: 'flex-end',
          ...(tightTopBar ? { top: 6, right: 8, gap: 0.25 } : {}),
        }}
      >
        {localMicMuted && (
          <Typography
            variant="caption"
            sx={{
              color: '#ff8a80',
              fontWeight: 700,
            }}
          >
            MIC OFF
          </Typography>
        )}
        {!localAiEnabled && (
          <Typography variant="caption" sx={{ color: '#ffb74d', fontWeight: 600 }}>
            AI OFF
          </Typography>
        )}
        <Tooltip
          title={
            localMicMuted
              ? 'Unmute'
              : 'Mute'
          }
        >
          <IconButton
            onClick={handleMicToggle}
            disabled={configLoading}
            aria-pressed={localMicMuted}
            aria-label={localMicMuted ? 'Unmute microphone' : 'Mute microphone'}
            sx={{
              color: localMicMuted ? '#ff8a80' : 'white',
              filter: localMicMuted
                ? 'drop-shadow(0 0 4px rgba(255, 82, 82, 0.95)) drop-shadow(0 0 10px rgba(255, 23, 68, 0.6))'
                : 'none',
            }}
          >
            {localMicMuted ? <MicOffIcon /> : <MicIcon />}
          </IconButton>
        </Tooltip>
        <Tooltip title={hasAdminSession ? 'Admin authenticated' : 'Admin locked'}>
          <IconButton
            onClick={openAdminDialog}
            sx={{ color: hasAdminSession ? '#66bb6a' : 'white' }}
            aria-label="Enter admin password"
          >
            {hasAdminSession ? <LockOpenIcon /> : <LockIcon />}
          </IconButton>
        </Tooltip>
        {hasAdminSession && (
          <Tooltip title="Training review">
            <IconButton
              component="a"
              href={trainingListenPageUrl()}
              target="_blank"
              rel="noopener noreferrer"
              sx={{ color: 'white' }}
              aria-label="Open training WAV review"
            >
              <HeadphonesOutlinedIcon />
            </IconButton>
          </Tooltip>
        )}
        <Tooltip title="Backend logs">
          <IconButton onClick={() => setLogsOpen(true)} sx={{ color: 'white' }} aria-label="Backend logs">
            <TerminalIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title="Settings">
          <IconButton onClick={() => setSettingsOpen((o) => !o)} sx={{ color: 'white' }} aria-label="Open settings">
            <SettingsIcon />
          </IconButton>
        </Tooltip>
      </Box>

      {/* Settings panel — dropdown from top-right */}
      <Collapse in={settingsOpen} sx={{ position: 'absolute', top: 52, right: 12, width: '90%', maxWidth: 420, zIndex: 10 }}>
        <Paper
          sx={{
            p: 2.5,
            borderRadius: 3,
            overflow: 'visible',
            border: '1px solid rgba(255, 255, 255, 0.14)',
            boxShadow: '0 12px 40px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.06)',
            bgcolor: 'rgba(36, 36, 38, 0.42)',
            backgroundImage:
              'linear-gradient(155deg, rgba(255, 255, 255, 0.07) 0%, rgba(255, 255, 255, 0.02) 42%, rgba(0, 0, 0, 0) 100%)',
            backdropFilter: 'blur(20px) saturate(165%)',
            WebkitBackdropFilter: 'blur(20px) saturate(165%)',
            '@media (max-width: 600px)': {
              bgcolor: 'rgba(22, 23, 26, 0.86)',
              border: '1px solid rgba(255, 255, 255, 0.18)',
              boxShadow: '0 14px 38px rgba(0, 0, 0, 0.55)',
              backgroundImage:
                'linear-gradient(155deg, rgba(255, 255, 255, 0.09) 0%, rgba(255, 255, 255, 0.02) 45%, rgba(0, 0, 0, 0) 100%)',
              backdropFilter: 'blur(14px) saturate(150%)',
              WebkitBackdropFilter: 'blur(14px) saturate(150%)',
            },
          }}
        >
          <Tabs
            value={settingsTab}
            onChange={(_e, v) => setSettingsTab(v)}
            variant="fullWidth"
            sx={{
              minHeight: 40,
              mb: 2,
              borderBottom: '1px solid rgba(255,255,255,0.12)',
              '& .MuiTab-root': { color: 'grey.400', textTransform: 'none', minHeight: 40, py: 1, fontSize: '0.78rem', px: 0.5 },
              '& .Mui-selected': { color: 'white !important' },
              '& .MuiTabs-indicator': { bgcolor: '#dcc6a8' },
            }}
          >
            <Tab label="Detection" />
            <Tab label="Alerts" />
            <Tab label="Browser" />
          </Tabs>

          {configLoading ? (
            <Typography sx={{ color: 'grey.400' }}>Loading...</Typography>
          ) : (
            <>
              {settingsTab === 0 && (
              <>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
                <Box>
                  <Typography sx={{ color: 'white', fontWeight: 600 }}>AI Bark Detection</Typography>
                  <Typography variant="caption" sx={{ color: 'grey.400' }}>
                    When off, any sound above the noise floor triggers an event
                  </Typography>
                </Box>
                <Switch checked={localAiEnabled} onChange={handleAiToggle} color="success" />
              </Box>

              <Box sx={{ mb: 3, pb: 1, opacity: localAiEnabled ? 1 : 0.4, pointerEvents: localAiEnabled ? 'auto' : 'none' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Typography sx={{ color: 'white', fontWeight: 600 }}>Bark Confidence Threshold</Typography>
                  <Tooltip title={`Reset to default (${Math.round(DEFAULTS.BARK_CONFIDENCE_THRESHOLD * 100)}%)`}>
                    <span><IconButton size="small" onClick={() => handleReset('BARK_CONFIDENCE_THRESHOLD')} disabled={nearlyEquals(localThreshold, DEFAULTS.BARK_CONFIDENCE_THRESHOLD)} sx={{ color: 'grey.500' }}><RestartAltIcon fontSize="small" /></IconButton></span>
                  </Tooltip>
                </Box>
                <Typography variant="caption" sx={{ color: 'grey.400', display: 'block', mb: 0.5 }}>
                  Minimum AI confidence to classify a sound as a bark
                </Typography>
                <Typography
                  variant="caption"
                  sx={{ color: '#a5d6a7', display: 'block', fontFamily: 'ui-monospace, monospace', fontWeight: 600, fontSize: '0.8rem' }}
                >
                  {localThreshold <= 0.005 ? 'any' : localThreshold >= 0.995 ? 'certain' : `${Math.round(localThreshold * 100)}%`}
                </Typography>
                <Slider
                  value={localThreshold}
                  onChange={(_e, v) => setLocalThreshold(v)}
                  onChangeCommitted={handleThresholdCommit}
                  min={0} max={1} step={0.01}
                  valueLabelDisplay="off"
                  marks={[
                    { value: 0, label: 'any' },
                    { value: 0.25, label: '25%' },
                    { value: 0.5, label: '50%' },
                    { value: 1, label: 'certain' },
                  ]}
                  sx={{
                    color: '#66bb6a',
                    mt: 0.5,
                    '& .MuiSlider-mark': { bgcolor: 'grey.600' },
                    '& .MuiSlider-markLabel': { color: 'grey.500', fontSize: '0.7rem' },
                    '& .MuiSlider-markLabel[data-index="0"]': { transform: 'translateX(0%)' },
                    '& .MuiSlider-markLabel[data-index="3"]': { transform: 'translateX(-100%)' },
                    '& .MuiSlider-thumb': {
                      width: 18,
                      height: 18,
                      boxShadow: '0 0 0 2px rgba(80, 180, 90, 0.5)',
                    },
                  }}
                />
              </Box>

              <Box sx={{ pb: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Typography sx={{ color: 'white', fontWeight: 600 }}>Noise Floor</Typography>
                  <Tooltip title={`Reset to default (${DEFAULTS.MIN_RMS_AMPLITUDE.toFixed(2)} RMS)`}>
                    <span><IconButton size="small" onClick={() => handleReset('MIN_RMS_AMPLITUDE')} disabled={nearlyEquals(localRms, DEFAULTS.MIN_RMS_AMPLITUDE)} sx={{ color: 'grey.500' }}><RestartAltIcon fontSize="small" /></IconButton></span>
                  </Tooltip>
                </Box>
                <Typography variant="caption" sx={{ color: 'grey.400', display: 'block' }}>
                  Minimum RMS (Higher = only louder clips pass the gate)
                </Typography>
                <Typography variant="caption" sx={{ color: '#90caf9', display: 'block', mt: 0.5, fontFamily: 'ui-monospace, monospace', fontWeight: 600 }}>
                  {localRms.toFixed(2)}
                </Typography>
                <Slider
                  value={localRms}
                  onChange={(_e, v) => setLocalRms(v)}
                  onChangeCommitted={handleRmsCommit}
                  min={0} max={1} step={0.01}
                  valueLabelDisplay="off"
                  marks={[{ value: 0 }, { value: DEFAULTS.MIN_RMS_AMPLITUDE }, { value: 0.5 }, { value: 1 }]}
                  sx={{ color: '#42a5f5', mt: 0.5, '& .MuiSlider-mark': { bgcolor: 'grey.600' } }}
                />
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mt: 0.5, px: 0.25, gap: 0.5 }}>
                  <Typography variant="caption" sx={{ color: 'grey.500', fontSize: '0.65rem', flex: '0 0 auto' }}>0</Typography>
                  <Typography variant="caption" sx={{ color: 'grey.500', fontSize: '0.65rem', textAlign: 'center', flex: 1, minWidth: 0 }}>{`default ${DEFAULTS.MIN_RMS_AMPLITUDE.toFixed(2)}`}</Typography>
                  <Typography variant="caption" sx={{ color: 'grey.500', fontSize: '0.65rem', textAlign: 'right', flex: '0 0 auto' }}>1.0</Typography>
                </Box>
              </Box>
              </>
              )}

              {settingsTab === 1 && (
              <>
              <Box sx={{ pb: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Typography sx={{ color: 'white', fontWeight: 600 }}>Alert Threshold</Typography>
                  <Tooltip title={`Reset to default (${DEFAULTS.DETECTION_THRESHOLD})`}>
                    <span><IconButton size="small" onClick={() => handleReset('DETECTION_THRESHOLD')} disabled={localDetThreshold === DEFAULTS.DETECTION_THRESHOLD} sx={{ color: 'grey.500' }}><RestartAltIcon fontSize="small" /></IconButton></span>
                  </Tooltip>
                </Box>
                <Typography variant="caption" sx={{ color: 'grey.400' }}>
                  Number of consecutive detections before triggering an alert
                </Typography>
                <Slider
                  value={localDetThreshold}
                  onChange={(_e, v) => setLocalDetThreshold(v)}
                  onChangeCommitted={handleDetThresholdCommit}
                  min={1} max={10} step={1}
                  valueLabelDisplay="auto"
                  marks={[{ value: 1, label: '1' }, { value: 3, label: '3' }, { value: 5, label: '5' }, { value: 10, label: '10' }]}
                  sx={{ color: '#ffa726', mt: 1, '& .MuiSlider-markLabel': { color: 'grey.500', fontSize: '0.7rem' } }}
                />
              </Box>

              <Box sx={{ mt: 2, pb: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Typography sx={{ color: 'white', fontWeight: 600 }}>Grouping Window</Typography>
                  <Tooltip title={`Reset to default (${DEFAULTS.AGGREGATION_TIMER}s)`}>
                    <span><IconButton size="small" onClick={() => handleReset('AGGREGATION_TIMER')} disabled={localAggrTimer === DEFAULTS.AGGREGATION_TIMER} sx={{ color: 'grey.500' }}><RestartAltIcon fontSize="small" /></IconButton></span>
                  </Tooltip>
                </Box>
                <Typography variant="caption" sx={{ color: 'grey.400' }}>
                  How long to keep grouping barks into one event before starting a new one
                </Typography>
                <Slider
                  value={localAggrTimer}
                  onChange={(_e, v) => setLocalAggrTimer(v)}
                  onChangeCommitted={handleAggrTimerCommit}
                  min={10} max={300} step={10}
                  valueLabelDisplay="auto"
                  valueLabelFormat={(v) => v >= 60 ? `${Math.floor(v / 60)}m${v % 60 ? ` ${v % 60}s` : ''}` : `${v}s`}
                  marks={[{ value: 10, label: '10s' }, { value: 60, label: '1m' }, { value: 120, label: '2m' }, { value: 300, label: '5m' }]}
                  sx={{ color: '#ab47bc', mt: 1, '& .MuiSlider-markLabel': { color: 'grey.500', fontSize: '0.7rem' }, '& .MuiSlider-markLabel[data-index="0"]': { transform: 'translateX(0%)' }, '& .MuiSlider-markLabel[data-index="3"]': { transform: 'translateX(-100%)' } }}
                />
              </Box>
              </>
              )}

              {settingsTab === 2 && (
              <Box sx={{ mb: 0.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Typography sx={{ color: 'white', fontWeight: 600 }}>Dog name</Typography>
                  <Tooltip title={DEFAULTS.DOG_NAME ? `Reset to default (${DEFAULTS.DOG_NAME})` : 'Clear name (default: empty)'}>
                    <span>
                      <IconButton
                        size="small"
                        onClick={() => handleReset('DOG_NAME')}
                        disabled={localDogName.trim() === DEFAULTS.DOG_NAME}
                        sx={{ color: 'grey.500' }}
                      >
                        <RestartAltIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                </Box>
                <Typography variant="caption" sx={{ color: 'grey.400', display: 'block', mb: 0.75 }}>
                  Shown in the browser tab as: {localDogName.trim() ? `Hey ${localDogName.trim()}` : 'Hey'}
                </Typography>
                <TextField
                  size="small"
                  fullWidth
                  value={localDogName}
                  onChange={(e) => setLocalDogName(e.target.value)}
                  onBlur={handleDogNameBlur}
                  placeholder="optional"
                  inputProps={{
                    maxLength: 64,
                    'aria-label': 'Dog name',
                    onKeyDown: (e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void handleDogNameBlur();
                      }
                    },
                  }}
                  sx={{
                    '& .MuiOutlinedInput-root': { bgcolor: 'rgba(255,255,255,0.06)', color: 'white' },
                    '& .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(255,255,255,0.2)' },
                  }}
                />
              </Box>
              )}
            </>
          )}
        </Paper>
      </Collapse>

      <Box
        sx={{
          display: 'flex',
          flexDirection: compactHeaderRow ? 'row' : 'column',
          alignItems: 'center',
          justifyContent: compactHeaderRow ? 'flex-start' : undefined,
          gap: compactHeaderRow ? 2 : undefined,
          width: '100%',
          maxWidth: compactHeaderRow ? '100%' : { xs: 480, sm: 520, md: 540 },
          mx: 'auto',
          boxSizing: 'border-box',
          pt: compactHeaderRow
            ? 'max(0.35rem, env(safe-area-inset-top, 0px))'
            : mqShortHeight
              ? 'clamp(0.35rem, 2vh, 0.75rem)'
              : 'clamp(3rem, 8vh, 6rem)',
          pb: compactHeaderRow ? 0.5 : undefined,
          pl: compactHeaderRow ? { xs: 0.5, sm: 1 } : undefined,
          pr: compactHeaderRow ? 'calc(env(safe-area-inset-right, 0px) + 138px)' : undefined,
        }}
      >
        <Box
          sx={{
            width: compactHeaderRow ? 72 : mqShortHeight ? 88 : 150,
            height: compactHeaderRow ? 72 : mqShortHeight ? 88 : 150,
            aspectRatio: '1 / 1',
            flexShrink: 0,
            borderRadius: '50%',
            overflow: 'hidden',
            borderStyle: 'solid',
            borderWidth: compactHeaderRow
              ? (localMicMuted ? 5 : 3)
              : mqShortHeight
                ? (localMicMuted ? 6 : 4)
                : (localMicMuted ? 9 : 5),
            borderColor: localMicMuted ? '#3a3532' : (aboveNoiseFloor ? '#ffcc80' : '#4caf50'),
            animation: localMicMuted
              ? 'none'
              : (aboveNoiseFloor ? 'pulseLightAmber 1s infinite' : 'breatheGreenCyanIdle 3s infinite ease-in-out'),
            ...(localMicMuted
              ? {
                boxShadow: '0 0 0 7px rgba(255, 224, 200, 0.18), 0 0 28px rgba(0,0,0,0.45)',
              }
              : {}),
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            bgcolor: 'rgba(200, 230, 218, 0.12)',
            mx: compactHeaderRow ? 0 : 'auto',
          }}
        >
          <img
            alt={localDogName.trim() || 'Dog'}
            src={dogImageFailed ? DOG_IMAGE_FALLBACK : dogImageSrc}
            onError={() => setDogImageFailed(true)}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
            }}
          />
        </Box>

        <Typography
          component="h1"
          variant="h4"
          sx={{
            mt: compactHeaderRow
              ? 0
              : mqShortHeight
                ? '1rem'
                : { xs: '5.5rem', sm: '6.25rem', md: '7rem' },
            mb: compactHeaderRow || mqShortHeight ? 1 : { xs: 2.5, sm: 3 },
            color: '#f5ebe0',
            width: '100%',
            maxWidth: compactHeaderRow ? 'none' : { xs: 480, sm: 520, md: 540 },
            mx: 'auto',
            px: 0,
            textAlign: compactHeaderRow ? 'left' : 'center',
            fontWeight: 600,
            letterSpacing: '0.02em',
            fontSize: compactHeaderRow
              ? '1.2rem'
              : mqShortHeight
                ? '1.15rem'
                : { xs: '1.45rem', sm: '1.6rem', md: '1.7rem' },
            textShadow: '0 1px 12px rgba(0,0,0,0.35)',
            ...(compactHeaderRow
              ? {
                  flex: '1 1 auto',
                  alignSelf: 'center',
                  minWidth: 0,
                }
              : {}),
          }}
        >
          <span role="img" aria-label="dog">🐶</span> Bark History
        </Typography>
      </Box>

      {error ? (
        <Box sx={{ width: '100%', maxWidth: { xs: 480, sm: 520, md: 540 }, mx: 'auto' }}>
          <ErrorBanner message={error} />
        </Box>
      ) : messages.length === 0 ? (
        <Typography
          sx={{
            mt: '1rem',
            color: 'rgba(245, 235, 224, 0.85)',
            width: '100%',
            maxWidth: { xs: 480, sm: 520, md: 540 },
            mx: 'auto',
            textAlign: 'center',
            letterSpacing: '0.02em',
            fontSize: { xs: '1.05rem', sm: '1.125rem' },
          }}
        >
          No barks yet... <span role="img" aria-label="sleeping">💤</span>
        </Typography>
      ) : (
        <Box
          sx={{
            alignSelf: 'stretch',
            width: '100%',
            maxWidth: { xs: 480, sm: 520, md: 540 },
            mx: 'auto',
            px: 0,
            boxSizing: 'border-box',
          }}
        >
          {/* Bulk actions bar */}
          {selected.size > 0 && (
            <Box sx={{ display: 'flex', alignItems: 'center', mb: 1, gap: 1 }}>
              <Checkbox
                checked={selected.size === messages.length && messages.length > 0}
                indeterminate={selected.size > 0 && selected.size < messages.length}
                onChange={toggleSelectAll}
                sx={{
                  color: 'grey.400',
                  '&.Mui-checked': { color: '#ef5350' },
                  '&.MuiCheckbox-indeterminate': { color: '#ffb74d' },
                }}
                size="small"
              />
              <Typography variant="body2" sx={{ color: 'rgba(245, 235, 224, 0.65)', flex: 1 }}>
                {selected.size} selected
              </Typography>
              <Button
                variant="contained"
                color="error"
                size="small"
                startIcon={<DeleteIcon />}
                onClick={handleBulkDelete}
              >
                Delete ({selected.size})
              </Button>
            </Box>
          )}

          <ul style={{ listStyle: 'none', padding: 0, margin: 0, width: '100%' }}>
            {sorted.map((msg) => (
              <li
                key={msg.id}
                className="bark-row"
                style={{
                  marginBottom: '0.85rem',
                  background: selected.has(msg.id)
                    ? 'linear-gradient(145deg, rgba(72, 62, 62, 0.98) 0%, rgba(58, 52, 54, 0.96) 100%)'
                    : '#2c2c2e',
                  padding: '1.125rem 1.125rem',
                  borderRadius: '14px',
                  border: selected.has(msg.id)
                    ? '1px solid rgba(232, 160, 140, 0.38)'
                    : '1px solid rgba(255, 255, 255, 0.07)',
                  boxShadow: selected.has(msg.id)
                    ? '0 6px 22px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.06)'
                    : '0 4px 18px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255,255,255,0.04)',
                  display: 'block',
                  position: 'relative',
                  color: '#f5ebe0',
                  transition: 'background 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease',
                  cursor: 'pointer',
                }}
                onClick={() => toggleSelect(msg.id)}
              >
                <Box
                  sx={{
                    position: 'absolute',
                    left: 2,
                    top: 0,
                    bottom: 0,
                    display: 'flex',
                    alignItems: 'center',
                    zIndex: 1,
                  }}
                >
                  <Checkbox
                    checked={selected.has(msg.id)}
                    onChange={() => toggleSelect(msg.id)}
                    onClick={(e) => e.stopPropagation()}
                    sx={{
                      color: 'grey.500',
                      '&.Mui-checked': { color: '#ef5350' },
                      p: 0.5,
                      opacity: selected.has(msg.id) ? 1 : 0,
                      transition: 'opacity 0.15s',
                      '.bark-row:hover &': { opacity: 1 },
                    }}
                    size="small"
                  />
                </Box>
                <Box
                  sx={{
                    width: '100%',
                    textAlign: 'center',
                    boxSizing: 'border-box',
                    px: { xs: 3.5, sm: 5 },
                  }}
                >
                  {isMobile && shouldCollapseMessage(msg.text) && (
                    <Box sx={{ display: 'flex', justifyContent: 'center', mb: 0.25 }}>
                      <Button
                        size="small"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleMessageExpanded(msg.id);
                        }}
                        sx={{
                          textTransform: 'none',
                          minWidth: 0,
                          px: 1,
                          color: '#90caf9',
                          fontSize: '0.72rem',
                          lineHeight: 1.2,
                        }}
                      >
                        {expandedMessages.has(msg.id) ? 'Collapse' : 'Expand details'}
                      </Button>
                    </Box>
                  )}
                  <Typography
                    component="div"
                    variant="body1"
                    sx={{
                      fontWeight: 700,
                      lineHeight: 1.45,
                      fontSize: { xs: '0.9375rem', sm: '1rem', md: '1.0625rem' },
                      color: 'rgba(255, 248, 240, 0.95)',
                    }}
                  >
                    {formatBarkTimestamp(msg.update_time || msg.create_time)}
                  </Typography>
                  <Typography
                    component="div"
                    variant="body1"
                    sx={{
                      lineHeight: 1.5,
                      fontSize: { xs: '1rem', sm: '1.0625rem', md: '1.125rem' },
                      color: 'rgba(245, 235, 224, 0.88)',
                      mt: 0.5,
                      ...(isMobile && shouldCollapseMessage(msg.text) && !expandedMessages.has(msg.id)
                        ? {
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                          }
                        : {}),
                    }}
                  >
                    {msg.text}
                  </Typography>
                </Box>
              </li>
            ))}
          </ul>
        </Box>
      )}

      <BackendLogsDialog open={logsOpen} onClose={() => setLogsOpen(false)} />

      <Snackbar
        open={snack.open}
        autoHideDuration={3000}
        onClose={() => setSnack((s) => ({ ...s, open: false }))}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity={snack.severity} variant="filled" sx={{ width: '100%' }}>
          {snack.message}
        </Alert>
      </Snackbar>

      <style>
        {`
          @keyframes pulseLightAmber {
            0% { transform: scale(1); border-color: #ffcc80; box-shadow: 0 0 12px rgba(255, 204, 128, 0.42), 0 0 28px rgba(255, 224, 178, 0.28), 0 0 42px rgba(255, 237, 213, 0.14), 0 4px 18px rgba(0,0,0,0.12); }
            50% { transform: scale(1.05); border-color: #ffe9c5; box-shadow: 0 0 20px rgba(255, 233, 197, 0.48), 0 0 38px rgba(255, 224, 178, 0.22), 0 0 52px rgba(255, 245, 230, 0.12), 0 6px 22px rgba(0,0,0,0.08); }
            100% { transform: scale(1); border-color: #ffcc80; box-shadow: 0 0 12px rgba(255, 204, 128, 0.42), 0 0 28px rgba(255, 224, 178, 0.28), 0 0 42px rgba(255, 237, 213, 0.14), 0 4px 18px rgba(0,0,0,0.12); }
          }
          @keyframes breatheGreenCyanIdle {
            0% { transform: scale(1); border-color: #4caf50; box-shadow: 0 0 10px rgba(76, 175, 80, 0.65), 0 0 26px rgba(129, 199, 132, 0.48), 0 0 42px rgba(77, 208, 225, 0.22), 0 4px 18px rgba(0,0,0,0.12); }
            50% { transform: scale(1.02); border-color: #a5d6a7; box-shadow: 0 0 18px rgba(165, 214, 167, 0.72), 0 0 38px rgba(76, 175, 80, 0.38), 0 0 54px rgba(128, 222, 234, 0.35), 0 6px 24px rgba(0,0,0,0.08); }
            100% { transform: scale(1); border-color: #4caf50; box-shadow: 0 0 10px rgba(76, 175, 80, 0.65), 0 0 26px rgba(129, 199, 132, 0.48), 0 0 42px rgba(77, 208, 225, 0.22), 0 4px 18px rgba(0,0,0,0.12); }
          }
        `}
      </style>
    </Box>
  );
}
