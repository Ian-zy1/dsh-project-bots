export function historyMessage(m) {
  const sender = m.sender ?? {};
  return { ...m, sender_type: sender.sender_type === 'app' ? 'bot' : sender.sender_type,
    sender_id: sender.open_bot_id ?? sender.id, content: m.content, message_id: m.message_id };
}
const complete = r => !r.data.has_more && r.meta?.pagination?.complete !== false;
export async function catchup(read, state, relay, config) {
  const end = new Date().toISOString(), start = state.data.meta.historySince ?? config.historySince;
  const r = await read(['im', '+chat-messages-list', '--chat-id', config.chatId, '--start', start, '--end', end,
    '--order', 'asc', '--page-all', '--page-limit', '20', '--no-reactions']);
  const roots = new Set(Object.values(state.data.bindings).map(b => b.originMessageId));
  for (const row of Object.values(state.data.dispatches ?? {})) {
    if (row.originMessageId && !row.decision) roots.add(row.originMessageId);
  }
  for (const m of r.data.messages ?? []) {
    await relay.receive(historyMessage(m));
    if (m.thread_id) roots.add(m.thread_id);
  }
  if (!complete(r)) throw Error('Incomplete group history; cursor retained');
  // Group history excludes thread replies. Always read bound origin threads, even if the root predates the cursor.
  for (const root of roots) {
    const replies = await read(['im', '+threads-messages-list', '--thread', root, '--order', 'asc', '--page-all', '--page-limit', '20', '--no-reactions']);
    for (const m of replies.data.messages ?? []) await relay.receive(historyMessage(m));
    if (!complete(replies)) throw Error('Incomplete thread history; cursor retained');
  }
  state.put('meta', 'historySince', end);
}
