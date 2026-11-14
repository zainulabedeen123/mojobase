import { useLocation, useNavigate } from 'react-router-dom';
import { LogOut, ChevronDown, Plug } from 'lucide-react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  cn,
} from '@insforge/ui';
import { Avatar, AvatarFallback, LanguageSelect, Separator, ThemeSelect } from '#components';
import { useTheme } from '#lib/contexts/ThemeContext';
import { useAuth } from '#lib/contexts/AuthContext';
import { useTranslation } from 'react-i18next';
import { useOpenConnectDialog } from './ConnectDialogContext';
import { getFeatureFlag } from '#lib/analytics/posthog';
import { FEATURE_FLAGS, FEATURE_FLAG_VARIANTS } from '#lib/analytics/constants';

// Import SVG icons
import MojobaseLogoLight from '#assets/logos/mojobase_light.svg';
import MojobaseLogoDark from '#assets/logos/mojobase_dark.svg';

export default function AppHeader() {
  const { t } = useTranslation('chrome');
  const { resolvedTheme } = useTheme();
  const { logout } = useAuth();
  const openConnectDialog = useOpenConnectDialog();
  const dashboardVariant = getFeatureFlag(FEATURE_FLAGS.DASHBOARD_V4_EXPERIMENT);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const isDTest = dashboardVariant === FEATURE_FLAG_VARIANTS.D_TEST;
  const isConnectDisabled = isDTest && pathname === '/dashboard/install';
  const adminLabel = t('header.administrator');

  const handleConnectClick = () => {
    if (isDTest) {
      void navigate('/dashboard/install');
      return;
    }
    openConnectDialog();
  };

  const getUserInitials = (label: string) => {
    if (!label) {
      return 'U';
    }
    const parts = label.split('@')[0].split('.');
    if (parts.length > 1) {
      return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
    }
    return label.substring(0, 2).toUpperCase();
  };

  const getAvatarColor = (label: string) => {
    if (!label) {
      return 'bg-gray-500';
    }
    const hash = label.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const colors = [
      'bg-blue-500',
      'bg-green-500',
      'bg-yellow-500',
      'bg-purple-500',
      'bg-pink-500',
      'bg-indigo-500',
    ];
    return colors[hash % colors.length];
  };

  return (
    <>
      <div className="h-12 w-full bg-semantic-2 border-b border-[var(--alpha-8)] z-50 flex items-center justify-between px-6">
        {/* Logo */}

        <a href="/dashboard" aria-label="Mojobase home">
          <img
            src={resolvedTheme === 'light' ? MojobaseLogoLight : MojobaseLogoDark}
            alt="Mojobase Logo"
            className="h-7 w-auto"
          />
        </a>

        {/* Right side controls */}
        <div className="flex items-center gap-1">
          <LanguageSelect />
          <ThemeSelect />
          <Separator className="h-5 mx-2" orientation="vertical" />
          {/* MCP Connection Status */}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleConnectClick}
            disabled={isConnectDisabled}
            className="gap-1 rounded-[14px] border-[var(--alpha-8)] px-2 [&_svg]:size-4"
          >
            <Plug aria-hidden="true" />
            <span>{t('header.connect')}</span>
          </Button>

          {/* User Profile*/}
          <Separator className="h-5 mx-2" orientation="vertical" />
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button className="w-50 flex items-center gap-3 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-[8px] pr-3 transition-all duration-200 group">
                <Avatar className="h-8 w-8 ring-2 ring-white dark:ring-gray-700 shadow-sm">
                  <AvatarFallback
                    className={cn('text-white font-medium text-sm', getAvatarColor(adminLabel))}
                  >
                    {getUserInitials(adminLabel)}
                  </AvatarFallback>
                </Avatar>
                <div className="text-left hidden md:block">
                  <p className="text-sm font-medium text-zinc-950 dark:text-zinc-100 leading-tight">
                    {t('header.admin')}
                  </p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">{adminLabel}</p>
                </div>
                <ChevronDown className="h-5 w-5 text-black dark:text-white hidden md:block ml-auto" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48" sideOffset={8} collisionPadding={16}>
              <DropdownMenuItem
                onClick={() => void logout()}
                className="cursor-pointer text-red-600 dark:text-red-400"
              >
                <LogOut className="mr-2 h-4 w-4" />
                <span>{t('header.signOut')}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </>
  );
}
