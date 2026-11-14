import { describe, expect, it } from 'vitest';
import { rebrandDocs } from '../../src/utils/mojobase-brand';

describe('rebrandDocs', () => {
  it('rewrites product, package, URL and env names for agents', () => {
    const out = rebrandDocs(
      [
        'InsForge SDK: npm install @insforge/sdk',
        "const insforge = createClient({ baseUrl: 'https://your-app.region.insforge.app' });",
        "await insforge.database.from('posts').select();",
        'NEXT_PUBLIC_INSFORGE_URL and VITE_INSFORGE_ANON_KEY',
        'See https://docs.insforge.dev/core-concepts',
      ].join('\n')
    );
    expect(out).not.toMatch(/insforge/i);
    expect(out).toContain('npm install @mojobase/sdk');
    expect(out).toContain(
      "const mojobase = createClient({ baseUrl: 'https://your-project.mojobase.dev' });"
    );
    expect(out).toContain("await mojobase.database.from('posts')");
    expect(out).toContain('NEXT_PUBLIC_MOJOBASE_URL and VITE_MOJOBASE_ANON_KEY');
    expect(out).toContain('https://mojobase.dev/docs');
  });

  it('keeps wire-level names that apps and the backend really use', () => {
    const text =
      'cookie insforge_access_token; DB postgresql://u:p@h:5432/insforge; INSFORGE_INTERNAL_URL';
    expect(rebrandDocs(text)).toBe(text);
  });
});
