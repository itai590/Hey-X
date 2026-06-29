import { describe, expect, test } from 'vitest';
import { renderTrainingListenDemo } from '../dev-demo-api';

describe('renderTrainingListenDemo', () => {
  test('replaces backend-served training page placeholders', () => {
    const template = [
      '<title>Hey — WAV review</title>',
      '<h1 id="training-listen-title">Hey — WAV review</h1>',
      '<span>__DISPLAY_TIME_ZONE_HTML__</span>',
      '<script>const zone = __DISPLAY_TIME_ZONE_JSON__;</script>',
    ].join('');

    const html = renderTrainingListenDemo(template, {
      title: 'Hey X — WAV review',
      timeZone: 'UTC',
    });

    expect(html).toContain('<title>Hey X — WAV review</title>');
    expect(html).toContain(
      '<h1 id="training-listen-title">Hey X — WAV review</h1>',
    );
    expect(html).toContain('<span>UTC</span>');
    expect(html).toContain('const zone = "UTC";');
    expect(html).not.toContain('__DISPLAY_TIME_ZONE_');
  });
});
