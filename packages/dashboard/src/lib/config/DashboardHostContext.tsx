import { createContext, useContext } from 'react';
import type {
  DashboardBackupInfo,
  DashboardInstanceInfo,
  DashboardModelCreditUsage,
  DashboardMode,
  DashboardApifyConnectionStatus,
  DashboardPosthogConnectionStatus,
  DashboardPosthogOpenResult,
  DashboardProjectInfo,
  DashboardUserInfo,
  DashboardMetricsRange,
  DashboardMetricsResponse,
  DashboardAdvisorSummary,
  DashboardAdvisorIssuesQuery,
  DashboardAdvisorIssuesResponse,
  DashboardAdvisorSuppression,
  DashboardAdvisorSuppressRequest,
} from '#types';

interface DashboardHostContextValue {
  backendUrl?: string;
  showNavbar?: boolean;
  mode: DashboardMode;
  getAuthorizationCode?: () => Promise<string>;
  useAuthorizationCodeRefresh?: boolean;
  onRouteChange?: (path: string) => void;
  onShowUpgradeDialog?: () => void;
  onOpenWhatsNew?: () => void;
  onOpenAgentPrompt?: () => void;
  onRequestAgentPrompt?: () => Promise<string>;
  onRenameProject?: (name: string) => Promise<void>;
  onDeleteProject?: () => Promise<void>;
  onRequestBackupInfo?: () => Promise<DashboardBackupInfo>;
  onCreateBackup?: (name: string) => Promise<void>;
  onDeleteBackup?: (backupId: string) => Promise<void>;
  onRenameBackup?: (backupId: string, name: string | null) => Promise<void>;
  onRestoreBackup?: (backupId: string) => Promise<void>;
  onRequestInstanceInfo?: () => Promise<DashboardInstanceInfo>;
  onRequestInstanceTypeChange?: (
    instanceType: string
  ) => Promise<{ success: boolean; instanceType?: string; error?: string }>;
  onUpdateVersion?: () => Promise<void>;
  onRequestUserInfo?: () => Promise<DashboardUserInfo>;
  onUpdatePreferredLocale?: (locale: string) => void;
  onRequestUserApiKey?: () => Promise<string>;
  onRequestModelCredits?: () => Promise<DashboardModelCreditUsage>;
  onRequestProjectMetrics?: (range: DashboardMetricsRange) => Promise<DashboardMetricsResponse>;
  onRequestAdvisorLatest?: () => Promise<DashboardAdvisorSummary | null>;
  onRequestAdvisorIssues?: (
    query: DashboardAdvisorIssuesQuery
  ) => Promise<DashboardAdvisorIssuesResponse>;
  onTriggerAdvisorScan?: () => Promise<void>;
  onRequestAdvisorSuppressions?: () => Promise<DashboardAdvisorSuppression[]>;
  onSuppressAdvisorIssue?: (req: DashboardAdvisorSuppressRequest) => Promise<void>;
  onUnsuppressAdvisorIssue?: (id: string) => Promise<void>;
  onConnectPosthog?: (projectId: string) => void;
  subscribePosthogConnectionStatus?: (
    cb: (event: DashboardPosthogConnectionStatus) => void
  ) => () => void;
  onOpenPosthog?: (projectId: string) => Promise<DashboardPosthogOpenResult>;
  onConnectApify?: (projectId: string) => void;
  subscribeApifyConnectionStatus?: (
    cb: (event: DashboardApifyConnectionStatus) => void
  ) => () => void;
}

const DashboardHostContext = createContext<DashboardHostContextValue | null>(null);
const DashboardProjectContext = createContext<DashboardProjectInfo | undefined>(undefined);

export const DashboardHostProvider = DashboardHostContext.Provider;
export const DashboardProjectProvider = DashboardProjectContext.Provider;

export function useDashboardHost() {
  const value = useContext(DashboardHostContext);
  if (!value) {
    throw new Error('useDashboardHost must be used within an InsForgeDashboard');
  }
  return value;
}

export function useDashboardProject() {
  return useContext(DashboardProjectContext);
}

export function useIsCloudHostingMode() {
  return useDashboardHost().mode === 'cloud-hosting';
}

// PostHog / Apify connect through the cloud's OAuth handoff only when the host
// provides it. Hosts without it (self-hosting, or a cloud host such as the
// Mojobase console that does not run those integrations) use the
// bring-your-own-key flow, which the project backend serves itself.
export function useUsesCloudAnalytics() {
  const host = useDashboardHost();
  return host.mode === 'cloud-hosting' && Boolean(host.onConnectPosthog);
}
export function useUsesCloudWebscraper() {
  const host = useDashboardHost();
  return host.mode === 'cloud-hosting' && Boolean(host.onConnectApify);
}
