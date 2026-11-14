export function isCloudHosting(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  if (window.location.origin.endsWith('.insforge.app')) {
    return true;
  }

  // Mojobase: a project's dashboard embedded in the Mojobase console
  // (https://mojobase.dev) runs in cloud-hosting mode so the console can sign
  // the user in and supply project info. Opened directly, it stays self-hosted
  // with its own admin login.
  return window.location.hostname.endsWith('.mojobase.dev') && isInIframe();
}

export function isInIframe(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.parent !== window;
}
