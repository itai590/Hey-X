import React, { useState, useEffect } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, Typography,
  InputAdornment, IconButton, Box,
} from '@mui/material';
import LockIcon from '@mui/icons-material/Lock';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import { setAdminToken } from '../authStorage';
import { apiUrl } from '../apiBase';

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 * @param {() => void} [props.onLoggedIn] Called after token is stored (e.g. retry pending save)
 */
export default function AdminLoginDialog({ open, onClose, onLoggedIn }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    if (open) {
      setPassword('');
      setError('');
      setShowPassword(false);
      setVerifying(false);
    }
  }, [open]);

  const submit = async () => {
    const t = password.trim();
    if (!t) {
      setError('Enter the admin password');
      return;
    }
    setError('');
    setVerifying(true);
    try {
      const res = await fetch(apiUrl('/auth/verify-admin'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: t }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof body.error === 'string' ? body.error : 'Invalid admin token');
        return;
      }
      setAdminToken(t);
      setPassword('');
      if (onLoggedIn) {
        onLoggedIn();
      } else {
        onClose();
      }
    } catch {
      setError('Could not verify — check network or try again');
    } finally {
      setVerifying(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="xs"
      fullWidth
      slotProps={{
        backdrop: {
          sx: {
            backgroundColor: 'rgba(0, 0, 0, 0.38)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
          },
        },
        paper: {
          sx: {
            color: 'white',
            bgcolor: 'rgba(26, 26, 26, 0.48)',
            backgroundImage:
              'linear-gradient(155deg, rgba(255, 255, 255, 0.08) 0%, rgba(255, 255, 255, 0.03) 45%, rgba(0, 0, 0, 0) 100%)',
            backdropFilter: 'blur(22px) saturate(165%)',
            WebkitBackdropFilter: 'blur(22px) saturate(165%)',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            boxShadow: '0 16px 48px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.06)',
          },
        },
      }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <LockIcon sx={{ color: '#66bb6a' }} />
        Admin password
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ color: 'grey.400', mb: 2 }}>
          The server requires a password to change settings or delete barks. Use the same value as{' '}
          <Typography component="span" variant="body2" sx={{ fontFamily: 'monospace', color: '#a5d6a7' }}>
            HEY_ADMIN_TOKEN
          </Typography>{' '}
          on the Pi. Stored in this browser tab until you close it.
        </Typography>
        <Box component="form" autoComplete="on" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <Box
            component="input"
            type="text"
            name="username"
            autoComplete="username"
            value="hey-admin"
            readOnly
            tabIndex={-1}
            aria-hidden="true"
            sx={{
              position: 'absolute',
              width: 1,
              height: 1,
              opacity: 0,
              pointerEvents: 'none',
            }}
          />
          <TextField
            autoFocus
            fullWidth
            variant="outlined"
            type={showPassword ? 'text' : 'password'}
            label="Password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }}
            error={!!error}
            helperText={error || ' '}
            InputLabelProps={{ shrink: true }}
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    onClick={() => setShowPassword((v) => !v)}
                    onMouseDown={(e) => e.preventDefault()}
                    edge="end"
                    sx={{ color: 'grey.400' }}
                  >
                    {showPassword ? <VisibilityOffIcon /> : <VisibilityIcon />}
                  </IconButton>
                </InputAdornment>
              ),
            }}
            inputProps={{
              autoCapitalize: 'none',
              autoCorrect: 'off',
              spellCheck: false,
            }}
            sx={{
              '& .MuiOutlinedInput-root': { bgcolor: 'rgba(255,255,255,0.06)', color: 'white' },
              '& .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(255,255,255,0.2)' },
              '& .MuiInputLabel-root': { color: 'grey.500' },
              '& .MuiFormHelperText-root': { color: error ? 'error.main' : 'transparent' },
            }}
          />
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} sx={{ color: 'grey.400' }}>Cancel</Button>
        <Button
          onClick={() => void submit()}
          variant="contained"
          color="success"
          disabled={verifying}
        >
          {verifying ? 'Verifying…' : 'Save session'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
