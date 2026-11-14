import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseAppKey, UsageTracker } from './usage-tracker.js';

// Mock node-fetch — vi.mock is hoisted, so use vi.hoisted for the mock fn
const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock('node-fetch', () => ({ default: mockFetch }));

describe('parseAppKey', () => {
  it('should parse app-key from valid insforge.app URL', () => {
    expect(parseAppKey('https://uhzx8md3.us-test.insforge.app')).toBe('uhzx8md3');
  });

  it('should parse app-key from different regions', () => {
    expect(parseAppKey('https://4cp6qchj.us-east.insforge.app')).toBe('4cp6qchj');
  });

  it('should return null for non-insforge.app domain', () => {
    expect(parseAppKey('https://4cp6ast.insforge.dev')).toBeNull();
  });

  it('should return null for localhost', () => {
    expect(parseAppKey('http://localhost:7130')).toBeNull();
  });

  it('should return null for invalid URL', () => {
    expect(parseAppKey('not-a-url')).toBeNull();
  });

  it('should return null for insforge.app without region segment', () => {
    expect(parseAppKey('https://myapp.insforge.app')).toBeNull();
  });

  it('should return null for too many subdomains', () => {
    // hostname: a.b.c.insforge.app — the regex expects exactly {key}.{region}.insforge.app
    expect(parseAppKey('https://a.b.c.insforge.app')).toBeNull();
  });
});

describe('UsageTracker', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true });
  });

  it('should not track usage when apiKey is empty', async () => {
    const tracker = new UsageTracker('http://localhost:7130', '');
    await tracker.trackUsage('test-tool');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends usage only to the project backend, never to a third-party platform', async () => {
    const tracker = new UsageTracker('https://abc123.mojobase.dev', 'test-key');
    await tracker.trackUsage('fetch-docs', true);
    await tracker.trackUsage('run-raw-sql', false);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    for (const [url, init] of mockFetch.mock.calls as [
      string,
      { headers: Record<string, string>; body: string },
    ][]) {
      expect(url).toBe('https://abc123.mojobase.dev/api/usage/mcp');
      expect(init.headers['x-api-key']).toBe('test-key');
    }
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toMatchObject({
      tool_name: 'fetch-docs',
      success: true,
    });
  });

  it('does not contact InsForge platform endpoints, even for remote sessions', async () => {
    const tracker = new UsageTracker('https://myapp.us-east.insforge.app', 'test-key', {
      projectId: 'p1',
      accessToken: 't',
      isRemote: true,
    });
    await tracker.trackUsage('fetch-docs', true);
    const urls = mockFetch.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(urls.some((u: string) => u.includes('api.insforge.dev'))).toBe(false);
  });
});
