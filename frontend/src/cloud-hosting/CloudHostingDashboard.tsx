import { InsForgeDashboard } from '@insforge/dashboard';
import { isInIframe, isMojobaseHost } from '../helpers';
import { useCloudHosting } from './useCloudHosting';

export function CloudHostingDashboard() {
  const {
    getAuthorizationCode,
    projectInfo,
    reportRouteChange,
    showUpgradeDialog,
    openWhatsNew,
    openAgentPrompt,
    renameProject,
    deleteProject,
    requestBackupInfo,
    createBackup,
    deleteBackup,
    renameBackup,
    restoreBackup,
    requestInstanceInfo,
    requestInstanceTypeChange,
    updateVersion,
    requestUserInfo,
    updatePreferredLocale,
    requestUserApiKey,
    requestAgentPrompt,
    requestModelCredits,
    requestProjectMetrics,
    connectPosthog,
    openPosthog,
    subscribePosthogConnectionStatus,
    connectApify,
    subscribeApifyConnectionStatus,
  } = useCloudHosting();

  // The Mojobase console does not run InsForge Cloud's PostHog / Apify OAuth, so
  // projects there connect those integrations with their own keys instead.
  const cloudIntegrations = !isMojobaseHost();

  return (
    <InsForgeDashboard
      mode="cloud-hosting"
      showNavbar={!isInIframe()}
      getAuthorizationCode={getAuthorizationCode}
      useAuthorizationCodeRefresh={isInIframe()}
      project={projectInfo}
      onRouteChange={reportRouteChange}
      onShowUpgradeDialog={showUpgradeDialog}
      onOpenWhatsNew={openWhatsNew}
      onOpenAgentPrompt={cloudIntegrations ? undefined : openAgentPrompt}
      onRequestAgentPrompt={cloudIntegrations ? undefined : requestAgentPrompt}
      onRenameProject={renameProject}
      onDeleteProject={deleteProject}
      onRequestBackupInfo={requestBackupInfo}
      onCreateBackup={createBackup}
      onDeleteBackup={deleteBackup}
      onRenameBackup={renameBackup}
      onRestoreBackup={restoreBackup}
      onRequestInstanceInfo={requestInstanceInfo}
      onRequestInstanceTypeChange={requestInstanceTypeChange}
      onUpdateVersion={updateVersion}
      onRequestUserInfo={requestUserInfo}
      onUpdatePreferredLocale={updatePreferredLocale}
      onRequestUserApiKey={requestUserApiKey}
      onRequestModelCredits={requestModelCredits}
      onRequestProjectMetrics={requestProjectMetrics}
      onConnectPosthog={cloudIntegrations ? connectPosthog : undefined}
      onOpenPosthog={cloudIntegrations ? openPosthog : undefined}
      subscribePosthogConnectionStatus={
        cloudIntegrations ? subscribePosthogConnectionStatus : undefined
      }
      onConnectApify={cloudIntegrations ? connectApify : undefined}
      subscribeApifyConnectionStatus={
        cloudIntegrations ? subscribeApifyConnectionStatus : undefined
      }
    />
  );
}
