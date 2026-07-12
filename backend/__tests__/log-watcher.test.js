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

  test('named patterns still match regardless of HTTP status', () => {
    const { matchPatterns } = loadWatcher();
    const line = nginxLogLine({ request: 'GET /wp-admin HTTP/1.1', status: 404 });
    expect(matchPatterns(line)).toEqual(['WordPress scan']);
  });

  test('config probe 404 matches (digest-only at processLine)', () => {
    const { matchPatterns } = loadWatcher();
    const line = nginxLogLine({ request: 'GET /config.json HTTP/1.1', status: 404 });
    expect(matchPatterns(line)).toEqual(['Config probe']);
  });

  test('config probe with HTTP 200 matches (high-severity candidate)', () => {
    const { matchPatterns } = loadWatcher();
    const line = nginxLogLine({ request: 'GET /config.json HTTP/1.1', status: 200 });
    expect(matchPatterns(line)).toEqual(['Config probe']);
  });

  test.each([
    ['GET /.env.orig HTTP/1.1', 400, 'Env file leak'],
    ['GET /.env HTTP/1.1', 404, 'Env file leak'],
    ['GET /.git/HEAD HTTP/1.1', 404, 'Git leak'],
    ['GET /.git/config HTTP/1.1', 403, 'Git leak'],
  ])('secret/git probe with failed status still matches for digest: %s %i', (request, status, cat) => {
    const { matchPatterns } = loadWatcher();
    expect(matchPatterns(nginxLogLine({ request, status }))).toEqual([cat]);
  });

  test.each([
    ['GET /.env HTTP/1.1'],
    ['GET /.git/config HTTP/1.1'],
  ])('secret/git probe with HTTP 200 still matches', (request) => {
    const { matchPatterns } = loadWatcher();
    expect(matchPatterns(nginxLogLine({ request, status: 200 }))).toEqual(
      request.includes('.env') ? ['Env file leak'] : ['Git leak'],
    );
  });
});

describe('log-watcher reserveAlertSlot', () => {
  afterEach(() => {
    jest.resetModules();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ALERT_')) delete process.env[key];
    }
  });

  test('alerts on the first hit from an IP', () => {
    const watcher = loadWatcher();
    watcher.resetWatcherStateForTests();

    expect(watcher.reserveAlertSlot('1.2.3.4')).toEqual({ action: 'alert' });
  });

  test('suppresses repeat alerts for the same IP during cooldown', () => {
    const watcher = loadWatcher({ ALERT_COOLDOWN_MINUTES: '60' });
    watcher.resetWatcherStateForTests();

    expect(watcher.reserveAlertSlot('1.2.3.4')).toEqual({ action: 'alert' });
    expect(watcher.reserveAlertSlot('1.2.3.4').action).toBe('cooldown');
    expect(watcher.reserveAlertSlot('5.6.7.8')).toEqual({ action: 'alert' });
  });

  test('allows another alert after the cooldown window', () => {
    jest.useFakeTimers();
    const watcher = loadWatcher({ ALERT_COOLDOWN_MINUTES: '1' });
    watcher.resetWatcherStateForTests();

    expect(watcher.reserveAlertSlot('1.2.3.4').action).toBe('alert');
    expect(watcher.reserveAlertSlot('1.2.3.4').action).toBe('cooldown');

    jest.advanceTimersByTime(61 * 1000);
    expect(watcher.reserveAlertSlot('1.2.3.4')).toEqual({ action: 'alert' });

    jest.useRealTimers();
  });

  test('keeps suppressing while hits stay inside the cooldown window', () => {
    jest.useFakeTimers();
    const watcher = loadWatcher({ ALERT_COOLDOWN_MINUTES: '1' });
    watcher.resetWatcherStateForTests();

    expect(watcher.reserveAlertSlot('1.2.3.4').action).toBe('alert');
    expect(watcher.reserveAlertSlot('1.2.3.4').action).toBe('cooldown');

    // Hit again inside the window, then let lastAlert expire.
    jest.advanceTimersByTime(50 * 1000);
    expect(watcher.reserveAlertSlot('1.2.3.4').action).toBe('cooldown');
    jest.advanceTimersByTime(20 * 1000);
    expect(watcher.reserveAlertSlot('1.2.3.4')).toEqual({ action: 'alert' });

    jest.useRealTimers();
  });
});

describe('log-watcher processLine status routing', () => {
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

  test('rejected shell injection (HTTP 400) never emails', async () => {
    const watcher = loadWatcher();
    watcher.resetWatcherStateForTests();
    const transport = fakeTransport();

    for (let i = 0; i < 5; i++) {
      await watcher.processLine(
        transport,
        nginxLogLine({
          ip: '45.79.123.76',
          request: 'GET /cgi-bin/luci HTTP/1.1',
          status: 400,
        }),
      );
    }

    expect(transport.sent).toHaveLength(0);

    await watcher.flushHourlyDigest(transport, {});
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].subject).toContain('5 suppressed');
    expect(transport.sent[0].text).toContain('45.79.123.76');
    expect(transport.sent[0].text).toContain('HTTP 400');
  });

  test('HTTP 200 shell injection emails immediately on first hit', async () => {
    const watcher = loadWatcher();
    watcher.resetWatcherStateForTests();
    const transport = fakeTransport();

    await watcher.processLine(
      transport,
      nginxLogLine({
        ip: '45.79.123.76',
        request: 'GET /cgi-bin/luci HTTP/1.1',
        status: 200,
      }),
    );

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].subject).toContain('45.79.123.76');
  });

  test('failed env probe does not email (digest only)', async () => {
    const watcher = loadWatcher();
    watcher.resetWatcherStateForTests();
    const transport = fakeTransport();

    await watcher.processLine(
      transport,
      nginxLogLine({ ip: '45.148.10.200', request: 'GET /.env.orig HTTP/1.1', status: 400 }),
    );

    expect(transport.sent).toHaveLength(0);
    await watcher.flushHourlyDigest(transport, {});
    expect(transport.sent).toHaveLength(1);
  });

  test('low-severity HTTP 200 alerts are dropped once the hourly cap is reached', async () => {
    const watcher = loadWatcher({ ALERT_MAX_EMAILS_PER_HOUR: '2' });
    watcher.resetWatcherStateForTests();
    const transport = fakeTransport();

    for (let i = 0; i < 5; i++) {
      const line = nginxLogLine({
        ip: `10.0.0.${i}`,
        request: 'GET /wp-admin HTTP/1.1',
        status: 200,
      });
      await watcher.processLine(transport, line);
    }

    expect(transport.sent).toHaveLength(2);
  });

  test('high-severity HTTP 200 alerts bypass the hourly cap', async () => {
    const watcher = loadWatcher({ ALERT_MAX_EMAILS_PER_HOUR: '1' });
    watcher.resetWatcherStateForTests();
    const transport = fakeTransport();

    // Exhaust the cap (1/h) with a low-severity 200 alert.
    await watcher.processLine(
      transport,
      nginxLogLine({ ip: '10.0.0.1', request: 'GET /wp-admin HTTP/1.1', status: 200 }),
    );
    expect(transport.sent).toHaveLength(1);

    // Further low-severity alerts are now suppressed by the cap.
    await watcher.processLine(
      transport,
      nginxLogLine({ ip: '10.0.0.2', request: 'GET /wp-login HTTP/1.1', status: 200 }),
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

  test('summarizes rejected matches and resets after sending', async () => {
    const watcher = loadWatcher();
    watcher.resetWatcherStateForTests();
    const transport = fakeTransport();

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
    expect(transport.sent[0].text).toContain('Response status codes:');
    expect(transport.sent[0].text).toContain('HTTP 404');
    expect(transport.sent[0].text).toContain('Rejected probes (non-200) are digest-only');

    await watcher.flushHourlyDigest(transport, {});
    expect(transport.sent).toHaveLength(1);
  });

  test('digest groups suppressed matches by response status code', async () => {
    const watcher = loadWatcher();
    watcher.resetWatcherStateForTests();
    const transport = fakeTransport();

    await watcher.processLine(
      transport,
      nginxLogLine({ ip: '10.0.0.1', request: 'GET /wp-admin HTTP/1.1', status: 404 }),
    );
    await watcher.processLine(
      transport,
      nginxLogLine({ ip: '10.0.0.2', request: 'GET /wp-login HTTP/1.1', status: 404 }),
    );
    await watcher.processLine(
      transport,
      nginxLogLine({ ip: '10.0.0.3', request: 'GET /phpmyadmin HTTP/1.1', status: 400 }),
    );

    await watcher.flushHourlyDigest(transport, {});
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].text).toContain('      2  HTTP 404');
    expect(transport.sent[0].text).toContain('      1  HTTP 400');
  });

  test('does not send a digest when nothing was suppressed', async () => {
    const watcher = loadWatcher();
    watcher.resetWatcherStateForTests();
    const transport = fakeTransport();

    await watcher.flushHourlyDigest(transport, {});
    expect(transport.sent).toHaveLength(0);
  });
});
