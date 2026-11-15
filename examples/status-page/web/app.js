const form = document.querySelector('form');
const submit = form.querySelector('button');
const feedback = document.querySelector('#feedback');
const list = document.querySelector('#records');
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function pill(status) { return element('span', labels[status], 'pill ' + status); }
function time(value) {
  if (!value) return '—';
  const input = value.includes('T') ? value : value.replace(' ', 'T') + 'Z';
  return new Intl.DateTimeFormat('zh-CN', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(input));
}
async function api(path, data) {
  const response = await fetch(path, data === undefined ? {} : {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败。');
  return result;
}
async function refresh() {
  const data = await api('/api/overview');
  render(data);
  submit.disabled = false;
}
function setOptions(select, items) {
  const selected = select.value;
  select.replaceChildren(...items.map(item => {
    const option = element('option', item.name);
    option.value = item.id;
    return option;
  }));
  if (items.some(item => String(item.id) === selected)) select.value = selected;
}
async function save(path, payload, success) {
  feedback.textContent = '';
  try { await api(path, payload); }
  catch (error) { feedback.textContent = error.message; return false; }
  try { await refresh(); feedback.textContent = success; }
  catch { feedback.textContent = success + ' 页面未能刷新，请重新加载。'; }
  return true;
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  submit.disabled = true;
  try { await create(Object.fromEntries(new FormData(form))); }
  finally { submit.disabled = false; }
});
refresh().catch(error => { feedback.textContent = '读取失败：' + error.message; });

const labels = {operational:'正常', degraded:'服务降级', outage:'服务中断'};
function render({services, incidents}) {
  setOptions(form.elements.service, services);
  const overall = services.some(item => item.status === 'outage') ? '部分服务中断' :
    services.some(item => item.status === 'degraded') ? '有服务处于降级状态' : '所有服务正常运行';
  document.querySelector('#overall').textContent = overall;
  document.querySelector('#services').replaceChildren(...services.map(service => {
    const row = element('div',undefined,'service');
    const title = element('h3',service.name);
    title.append(pill(service.status));
    const chart = element('div',undefined,'timeline');
    chart.setAttribute('role','img');
    chart.setAttribute('aria-label',service.history.map(day => day.date + ' ' + labels[day.status]).join('，'));
    for (const day of service.history) {
      const status = element('span',undefined,'segment ' + day.status);
      status.title = day.date + ' · ' + labels[day.status];
      chart.append(status);
    }
    row.append(title,chart);
    return row;
  }));
  list.replaceChildren(...incidents.map(incident => {
    const item = element('li');
    item.append(element('strong',incident.title), element('p',incident.name + ' · ' + labels[incident.impact]),
      element('time', time(incident.openedAt) + (incident.resolvedAt ? ' · 已恢复 ' + time(incident.resolvedAt) : ' · 处理中'),'muted'));
    if (!incident.resolvedAt) {
      const resolve = element('button','标记恢复');
      resolve.type = 'button';
      resolve.addEventListener('click', async () => {
        resolve.disabled = true;
        try { await save('/api/incidents/' + incident.id + '/resolve', {}, '事件已恢复。'); }
        finally { resolve.disabled = false; }
      });
      item.append(resolve);
    }
    return item;
  }));
}
async function create(data) {
  if (await save('/api/incidents', { ...data, service:Number(data.service) }, '事件已发布。')) form.elements.title.value = '';
}
