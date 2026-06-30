/** Minimal nginx combined-log line for pattern tests (ip/timestamp are irrelevant to matching). */
function nginxLogLine({ ip = '203.0.113.1', request, status = 400 }) {
  return `${ip} - - [01/Jan/2026 00:00:00 +0000] "${request}" ${status} 150 "-" "-" "-"`;
}

function loadWatcher(env = {}) {
  jest.resetModules();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ALERT_')) delete process.env[key];
  }
  Object.assign(process.env, env);
  return require('../log-watcher');
}

describe('log-watcher matchPatterns', () => {
  afterEach(() => {
    jest.resetModules();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ALERT_')) delete process.env[key];
    }
  });

  test('binary garbage is categorized without standalone HTTP 400 alerts', () => {
    const { matchPatterns } = loadWatcher();
    const line = nginxLogLine({
      request: 'l\\x00\\x0B\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00',
    });
    expect(matchPatterns(line)).toEqual(['Binary protocol probe']);
  });

  test('generic HTTP 400 scan paths do not alert by default', () => {
    const { matchPatterns } = loadWatcher();
    const line = nginxLogLine({ request: 'GET /aaa9 HTTP/1.1' });
    expect(matchPatterns(line)).toEqual([]);
  });

  test('HTTP 400 alerts when ALERT_LOG_HTTP_STATUS includes 400', () => {
    const { matchPatterns } = loadWatcher({ ALERT_LOG_HTTP_STATUS: '400' });
    const line = nginxLogLine({ request: 'GET /aaa9 HTTP/1.1' });
    expect(matchPatterns(line)).toEqual(['HTTP 400']);
  });

  test('named patterns still alert regardless of HTTP status opt-in', () => {
    const { matchPatterns } = loadWatcher();
    const line = nginxLogLine({ request: 'GET /wp-admin HTTP/1.1', status: 404 });
    expect(matchPatterns(line)).toEqual(['WordPress scan']);
  });

  test('config probe 404 is scanner noise and does not match by default', () => {
    const { matchPatterns } = loadWatcher();
    const line = nginxLogLine({ request: 'GET /config.json HTTP/1.1', status: 404 });
    expect(matchPatterns(line)).toEqual([]);
  });

  test('config probe with a non-404 response matches (high-severity candidate)', () => {
    const { matchPatterns } = loadWatcher();
    const line = nginxLogLine({ request: 'GET /config.json HTTP/1.1', status: 200 });
    expect(matchPatterns(line)).toEqual(['Config probe']);
  });
});

describe('log-watcher reserveAlertSlot', () => {
  afterEach(() => {
    jest.resetModules();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ALERT_')) delete process.env[key];
    }
  });

  test('does not alert until more than 3 consecutive hits from the same IP', () => {
    const watcher = loadWatcher({ ALERT_MIN_HITS_PER_IP: '3' });
    watcher.resetWatcherStateForTests();

    expect(watcher.reserveAlertSlot('1.2.3.4').action).toBe('below_threshold');
    expect(watcher.reserveAlertSlot('1.2.3.4').action).toBe('below_threshold');
    expect(watcher.reserveAlertSlot('1.2.3.4').action).toBe('below_threshold');
    expect(watcher.reserveAlertSlot('1.2.3.4')).toEqual({
      action: 'alert',
      prevSuppressed: 0,
      streakHits: 4,
    });
  });

  test('single hit from an IP never alerts with default threshold', () => {
    const watcher = loadWatcher();
    watcher.resetWatcherStateForTests();

    expect(watcher.reserveAlertSlot('1.2.3.4').action).toBe('below_threshold');
  });

  test('high-severity bypass alerts on the first hit', () => {
    const watcher = loadWatcher({ ALERT_MIN_HITS_PER_IP: '3' });
    watcher.resetWatcherStateForTests();

    expect(watcher.reserveAlertSlot('1.2.3.4', true)).toEqual({
      action: 'alert',
      prevSuppressed: 0,
      streakHits: 1,
    });
    expect(watcher.reserveAlertSlot('1.2.3.4', true).action).toBe('cooldown');
  });

  test('suppresses repeat alerts for the same IP during cooldown', () => {
    const watcher = loadWatcher({ ALERT_MIN_HITS_PER_IP: '0', ALERT_COOLDOWN_MINUTES: '60' });
    watcher.resetWatcherStateForTests();

    expect(watcher.reserveAlertSlot('1.2.3.4')).toEqual({
      action: 'alert',
      prevSuppressed: 0,
      streakHits: 1,
    });
    expect(watcher.reserveAlertSlot('1.2.3.4').action).toBe('cooldown');
    expect(watcher.reserveAlertSlot('5.6.7.8')).toEqual({
      action: 'alert',
      prevSuppressed: 0,
      streakHits: 1,
    });
  });

  test('resets streak after cooldown gap and requires threshold again', () => {
    jest.useFakeTimers();
    const watcher = loadWatcher({ ALERT_MIN_HITS_PER_IP: '3', ALERT_COOLDOWN_MINUTES: '1' });
    watcher.resetWatcherStateForTests();

    for (let i = 0; i < 4; i++) watcher.reserveAlertSlot('1.2.3.4');
    expect(watcher.reserveAlertSlot('1.2.3.4').action).toBe('below_threshold');

    jest.advanceTimersByTime(61 * 1000);
    expect(watcher.reserveAlertSlot('1.2.3.4').action).toBe('below_threshold');
    expect(watcher.reserveAlertSlot('1.2.3.4').action).toBe('below_threshold');
    expect(watcher.reserveAlertSlot('1.2.3.4').action).toBe('below_threshold');
    expect(watcher.reserveAlertSlot('1.2.3.4')).toEqual({
      action: 'alert',
      prevSuppressed: 0,
      streakHits: 4,
    });

    jest.useRealTimers();
  });
});

describe('log-watcher processLine hourly cap', () => {
  afterEach(() => {
    jest.resetModules();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ALERT_')) delete process.env[key];
    }
  });

  function fakeTransport() {
    const sent = [];
    return {
      sent,
      sendMail: jest.fn(async (msg) => {
        sent.push(msg);
      }),
    };
  }

  test('low-severity alerts are dropped once the hourly cap is reached', async () => {
    const watcher = loadWatcher({
      ALERT_MIN_HITS_PER_IP: '0',
      ALERT_MAX_EMAILS_PER_HOUR: '2',
      ALERT_LOG_HTTP_STATUS: '400',
    });
    watcher.resetWatcherStateForTests();
    const transport = fakeTransport();

    for (let i = 0; i < 5; i++) {
      const line = nginxLogLine({ ip: `10.0.0.${i}`, request: 'GET /aaa9 HTTP/1.1' });
      await watcher.processLine(transport, line);
    }

    expect(transport.sent).toHaveLength(2);
  });

  test('high-severity alerts bypass the hourly cap', async () => {
    const watcher = loadWatcher({
      ALERT_MIN_HITS_PER_IP: '0',
      ALERT_MAX_EMAILS_PER_HOUR: '1',
      ALERT_LOG_HTTP_STATUS: '400',
    });
    watcher.resetWatcherStateForTests();
    const transport = fakeTransport();

    // Exhaust the cap (1/h) with a low-severity alert.
    await watcher.processLine(
      transport,
      nginxLogLine({ ip: '10.0.0.1', request: 'GET /aaa9 HTTP/1.1', status: 400 }),
    );
    expect(transport.sent).toHaveLength(1);

    // Further low-severity alerts are now suppressed by the cap.
    await watcher.processLine(
      transport,
      nginxLogLine({ ip: '10.0.0.2', request: 'GET /aaa9 HTTP/1.1', status: 400 }),
    );
    expect(transport.sent).toHaveLength(1);

    // High-severity (.env leak) still sends despite the exhausted cap.
    for (let i = 0; i < 3; i++) {
      await watcher.processLine(
        transport,
        nginxLogLine({ ip: `10.9.9.${i}`, request: 'GET /.env HTTP/1.1', status: 200 }),
      );
    }
    const subjects = transport.sent.map((m) => m.subject);
    expect(subjects.filter((s) => s.includes('10.9.9'))).toHaveLength(3);
  });
});

describe('log-watcher flushHourlyDigest', () => {
  afterEach(() => {
    jest.resetModules();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ALERT_')) delete process.env[key];
    }
  });

  function fakeTransport() {
    const sent = [];
    return {
      sent,
      sendMail: jest.fn(async (msg) => {
        sent.push(msg);
      }),
    };
  }

  test('summarizes suppressed matches and resets after sending', async () => {
    const watcher = loadWatcher({ ALERT_MIN_HITS_PER_IP: '3' });
    watcher.resetWatcherStateForTests();
    const transport = fakeTransport();

    // 3 low-severity hits stay below threshold → all suppressed, none emailed.
    for (let i = 0; i < 3; i++) {
      await watcher.processLine(
        transport,
        nginxLogLine({ ip: '10.0.0.5', request: 'GET /wp-admin HTTP/1.1', status: 404 }),
      );
    }
    expect(transport.sent).toHaveLength(0);

    await watcher.flushHourlyDigest(transport, {});
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].subject).toContain('3 suppressed');
    expect(transport.sent[0].text).toContain('10.0.0.5');

    // Nothing left to report → no second digest.
    await watcher.flushHourlyDigest(transport, {});
    expect(transport.sent).toHaveLength(1);
  });

  test('does not send a digest when nothing was suppressed', async () => {
    const watcher = loadWatcher();
    watcher.resetWatcherStateForTests();
    const transport = fakeTransport();

    await watcher.flushHourlyDigest(transport, {});
    expect(transport.sent).toHaveLength(0);
  });
});
