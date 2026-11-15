const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Shanghai',
});

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) {
    return '未知';
  }
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) {
    return '未知';
  }
  return `${dateTimeFormatter.format(value)}（Asia/Shanghai）`;
}

export function formatShortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 12) : '未提供';
}
