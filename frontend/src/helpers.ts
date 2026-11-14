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
  return isMojobaseHost() && isInIframe();
}

export function isMojobaseHost(): boolean {
  return typeof window !== 'undefined' && window.location.hostname.endsWith('.mojobase.dev');
}

export function isInIframe(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.parent !== window;
}
