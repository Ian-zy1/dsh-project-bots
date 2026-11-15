/** Request identifiers are not credentials; getRandomValues also works on HTTP origins. */
export function requestKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  // HTTP pages lack the async Clipboard API. Keep copying tied to the user's click.
  const active = document.activeElement;
  const area = document.createElement('textarea');
  area.value = text; area.readOnly = true;
  area.style.position = 'fixed'; area.style.opacity = '0';
  (document.querySelector('dialog[open]') ?? document.body).append(area);
  try {
    area.focus(); area.select();
    if (!document.execCommand?.('copy')) throw new Error('Clipboard unavailable');
  } finally {
    area.remove();
    if (active instanceof HTMLElement) active.focus();
  }
}
