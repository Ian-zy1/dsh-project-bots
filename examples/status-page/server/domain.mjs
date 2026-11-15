import { inputText, ValidationError } from './app.mjs';

const dayMs = 86_400_000;
const labels = ['官网和文档', '账户服务', '通知网关'];
export const domain = {
  createPath: '/api/incidents',
  init(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS services (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS incidents (id INTEGER PRIMARY KEY, service INTEGER NOT NULL REFERENCES services(id),
        title TEXT NOT NULL, impact TEXT NOT NULL CHECK (impact IN ('degraded','outage')), openedAt TEXT NOT NULL, resolvedAt TEXT);
    `);
    db.exec('BEGIN');
    try {
      const service = db.prepare('INSERT OR IGNORE INTO services VALUES (?,?)');
      labels.forEach((name, index) => service.run(index + 1, name));
      const now = Date.now();
      db.prepare('INSERT OR IGNORE INTO incidents VALUES (1,3,?,?,?,?)').run('部分通知延迟', 'degraded',
        new Date(now - 2 * dayMs).toISOString(), new Date(now - 2 * dayMs + 75 * 60_000).toISOString());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  },
  overview(db) {
    const incidents = db.prepare('SELECT i.*,s.name FROM incidents i JOIN services s ON i.service=s.id ORDER BY i.id DESC').all();
    const now = Date.now();
    const today = new Date(now).setUTCHours(0,0,0,0);
    const dates = Array.from({length:14}, (_, i) => today - (13-i)*dayMs);
    const priority = item => item.impact === 'outage' ? 2 : 1;
    const status = value => ['operational','degraded','outage'][value];
    const services = db.prepare('SELECT * FROM services ORDER BY id').all().map(service => {
      const related = incidents.filter(item => item.service === service.id);
      return { ...service,
        status: status(related.filter(item => !item.resolvedAt).reduce((max, item) => Math.max(max, priority(item)), 0)),
        history: dates.map(from => ({
          date: new Date(from).toISOString().slice(0,10),
          status: status(related.filter(item => Date.parse(item.openedAt) < from+dayMs && (item.resolvedAt ? Date.parse(item.resolvedAt) : now) >= from)
            .reduce((max, item) => Math.max(max, priority(item)), 0)),
        })),
      };
    });
    return { services, incidents: incidents.slice(0, 30) };
  },
  create(db, request) {
    const { service, title, impact } = request ?? {};
    if (!Number.isSafeInteger(service) || !db.prepare('SELECT 1 FROM services WHERE id=?').get(service)) throw new ValidationError('请选择已有服务。');
    if (!['degraded','outage'].includes(impact)) throw new ValidationError('请选择影响程度。');
    return db.prepare('INSERT INTO incidents(service,title,impact,openedAt) VALUES (?,?,?,?) RETURNING id')
      .get(service, inputText(title, '事件标题', 90), impact, new Date().toISOString());
  },
  resolve(db, id) {
    const row = db.prepare('UPDATE incidents SET resolvedAt=COALESCE(resolvedAt,?) WHERE id=? RETURNING id,resolvedAt').get(new Date().toISOString(), id);
    if (!row) throw new ValidationError('找不到该事件。');
    return row;
  },
};
