import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

const theme = vi.hoisted(() => ({ resolvedTheme: 'dark' as 'dark' | 'light' }));

vi.mock('#lib/contexts/ThemeContext', () => ({
  useTheme: () => ({ resolvedTheme: theme.resolvedTheme, theme: theme.resolvedTheme }),
}));
vi.mock('#lib/contexts/AuthContext', () => ({
  useAuth: () => ({ logout: vi.fn(), user: { email: 'admin' } }),
}));
vi.mock('#layout/ConnectDialogContext', () => ({ useOpenConnectDialog: () => vi.fn() }));
vi.mock('#lib/analytics/posthog', () => ({ getFeatureFlag: () => undefined }));
vi.mock('#components', () => ({
  Avatar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AvatarFallback: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  LanguageSelect: () => null,
  ThemeSelect: () => null,
  Separator: () => null,
}));

import AppHeader from '#layout/AppHeader';

function renderHeader() {
  return render(
    <MemoryRouter>
      <AppHeader />
    </MemoryRouter>
  );
}

describe('AppHeader branding', () => {
  it('shows the Mojobase logo for the active theme', () => {
    theme.resolvedTheme = 'dark';
    const { unmount } = renderHeader();
    expect(screen.getByAltText('Mojobase Logo').getAttribute('src')).toMatch(/mojobase_dark/);
    unmount();

    theme.resolvedTheme = 'light';
    renderHeader();
    expect(screen.getByAltText('Mojobase Logo').getAttribute('src')).toMatch(/mojobase_light/);
  });

  it('does not link to the upstream InsForge community', () => {
    const { container } = renderHeader();
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs.some((h) => h?.includes('insforge') || h?.includes('discord'))).toBe(false);
  });
});
