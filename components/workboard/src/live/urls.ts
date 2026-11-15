/** The page and its API share a deployment root, e.g. / or /aw/. */
export function applicationRoot(): URL {
  return new URL('./', window.location.href);
}

export function apiPath(path = ''): string {
  return `${applicationRoot().pathname}api/v1${path}`;
}

export function applicationOrigin(): string {
  return applicationRoot().href.replace(/\/$/, '');
}
