import { afterEach, expect, test, vi } from 'vitest';
import { copyText, requestKey } from './browser';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(navigator, 'clipboard'); Reflect.deleteProperty(document, 'execCommand'); });

test('request identifiers work without the secure-context randomUUID method', () => {
  vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
  const first = requestKey(), second = requestKey();
  expect(first).toMatch(/^[a-f0-9]{32}$/);
  expect(first).not.toBe(second);
});

test('HTTP clipboard fallback copies the requested selection and restores focus', async () => {
  Reflect.deleteProperty(navigator, 'clipboard');
  const button = document.createElement('button'); document.body.append(button); button.focus();
  const command = vi.fn(() => {
    const selection = document.activeElement as HTMLTextAreaElement;
    expect(selection.value.slice(selection.selectionStart, selection.selectionEnd)).toBe('HTTP 精确复制');
    return true;
  });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: command });
  await copyText('HTTP 精确复制');
  expect(command).toHaveBeenCalledWith('copy');
  expect(document.activeElement).toBe(button);
  expect(document.querySelector('textarea')).toBeNull(); button.remove();
});

test('unsupported or denied clipboard does not report success', async () => {
  Reflect.deleteProperty(navigator, 'clipboard');
  Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false });
  await expect(copyText('x')).rejects.toThrow();
  expect(document.querySelector('textarea')).toBeNull();
  const command = vi.fn(() => true);
  Object.defineProperty(document, 'execCommand', { configurable: true, value: command });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
  await expect(copyText('x')).rejects.toThrow('denied');
  expect(command).not.toHaveBeenCalled();
});
