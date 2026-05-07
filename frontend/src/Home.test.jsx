import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import Home from './Home';
import theme from './theme';
import { AdminAuthProvider } from './AdminAuthProvider';

vi.mock('./hooks/useMessages', () => ({
  default: () => ({
    messages: [
      {
        id: 'b1',
        text: 'Woof!',
        create_time: '2026-01-15T10:00:00.000Z',
        update_time: '2026-01-15T10:00:00.000Z',
      },
    ],
    error: null,
    reload: vi.fn(),
  }),
}));

/** Must match useConfig mock below (dog identity tests). */
const DOG_NAME = 'Sheldon';

vi.mock('./hooks/useConfig', () => ({
  default: () => ({
    config: {
      BARK_CONFIDENCE_THRESHOLD: 0.25,
      MIN_RMS_AMPLITUDE: 0.3,
      AI_DETECTION_ENABLED: true,
      DETECTION_THRESHOLD: 1,
      AGGREGATION_TIMER: 60,
      MIC_MUTED: false,
      DOG_NAME,
      DOG_IMAGE_FILE: `${DOG_NAME}.jpeg`,
    },
    loading: false,
    error: null,
    updateConfig: vi.fn(),
    reload: vi.fn(),
  }),
}));

function renderHome() {
  return render(
    <ThemeProvider theme={theme}>
      <AdminAuthProvider>
        <Home />
      </AdminAuthProvider>
    </ThemeProvider>,
  );
}

describe('Home UI', () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  beforeEach(() => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            micMuted: false,
            lastRms: null,
            lastRmsTime: null,
            serverTime: new Date().toISOString(),
            lastRmsAboveFloor: null,
          }),
      }),
    );
  });

  test('renders bark history heading and one message row', () => {
    renderHome();
    expect(screen.getByRole('heading', { name: /bark history/i })).toBeInTheDocument();
    expect(screen.getByText('Woof!')).toBeInTheDocument();
  });

  test('exposes settings, lock, and mic controls', () => {
    renderHome();
    expect(screen.getByRole('button', { name: /enter admin password/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /backend logs/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /mute microphone|unmute microphone/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button').length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByRole('link', { name: /open training wav review/i })).not.toBeInTheDocument();
  });

  test('shows training WAV review link when admin token is in session', () => {
    sessionStorage.setItem('hey-admin-token', 'test-admin-token');
    renderHome();
    const link = screen.getByRole('link', { name: /open training wav review/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('/api/training/listen'));
    expect(link).toHaveAttribute('target', '_blank');
  });

  test('sets document title from dog name in config', () => {
    renderHome();
    expect(document.title).toMatch(new RegExp(`Hey ${DOG_NAME}`));
  });

  test('avatar uses dog name and image file from config', () => {
    renderHome();
    const img = screen.getByRole('img', { name: new RegExp(DOG_NAME, 'i') });
    expect(img).toHaveAttribute(
      'src',
      expect.stringMatching(new RegExp(`${DOG_NAME}\\.jpeg$`)),
    );
  });

  test('opens settings panel with Detection / Alerts / Browser tabs', async () => {
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole('button', { name: /^open settings$/i }));
    expect(screen.getByRole('tab', { name: /^Detection$/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^Alerts$/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^Browser$/i })).toBeInTheDocument();
  });
});
