'use strict';
/**
 * 假的高级 Gmail 服务（Gmail.Users.Messages.list / get），以及把合成样本做成 Gmail API Message 的小工具。
 * 不连接任何真实邮箱。所有样本都是手写的合成内容（tests/fixtures/synthetic-mail.js）。
 */

/** 合成样本 → Gmail API 的 Message（format: 'full'）：multipart/alternative，正文是 base64url。 */
function apiMessage({ id, from, subject, html = '', text = '', at, labelIds = [] }) {
  const enc = (s) => Buffer.from(String(s), 'utf8').toString('base64url');
  const parts = [];
  if (text) parts.push({ mimeType: 'text/plain', filename: '', body: { data: enc(text) } });
  if (html) parts.push({ mimeType: 'text/html', filename: '', body: { data: enc(html) } });
  parts.push({ mimeType: 'application/pdf', filename: 'receipt.pdf', body: { attachmentId: 'att-1' } });
  return {
    id, threadId: id, internalDate: String(new Date(at).getTime()), labelIds,
    payload: {
      mimeType: 'multipart/mixed',
      headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }, { name: 'To', value: 'me@example.test' }],
      parts: [{ mimeType: 'multipart/alternative', filename: '', parts }]
    }
  };
}

/**
 * fakeGmail(messages)：messages 为 apiMessage 的结果。list 按查询里的 from:(域名) 和 newer_than:Nd 过滤，按到达时间从新到旧，
 * 支持 maxResults / pageToken。可注入错误：fail.list / fail.get = Error 或 (id) => Error。
 * now()：newer_than 的参照时间（默认真实时间）。
 */
function fakeGmail(messages = [], { now = () => Date.now() } = {}) {
  const store = new Map(messages.map((m) => [m.id, m]));
  const calls = { list: [], get: [] };
  const fail = { list: null, get: null };
  function matches(m, q) {
    const from = (m.payload.headers.find((h) => h.name === 'From') || {}).value || '';
    const text = String(q), lowerFrom = from.toLowerCase();
    const branches = text.includes(' OR ') ? text.split(' OR ') : [text];
    const branchMatch = (branch) => {
      const excluded = [...branch.matchAll(/-from:\(([^)]+)\)/g)].map((x) => x[1].trim().toLowerCase());
      if (excluded.some((d) => lowerFrom.includes('@' + d) || lowerFrom.includes('.' + d))) return false;
      const domains = [...branch.matchAll(/(?<!-)from:\(([^)]+)\)/g)].map((x) => x[1].trim().toLowerCase());
      if (domains.length) return domains.some((d) => lowerFrom.includes('@' + d) || lowerFrom.includes('.' + d));
      if (branch.includes('category:purchases') || /subject:/.test(branch)) {
        const subject = ((m.payload.headers.find((h) => h.name === 'Subject') || {}).value || '').toLowerCase();
        const terms = [...branch.matchAll(/subject:([^\s)}]+)/g)].map((x) => x[1].toLowerCase());
        const subjectMatch = terms.some((term) => subject.includes(term));
        const categoryMatch = branch.includes('category:purchases') && (m.labelIds || []).includes('CATEGORY_PURCHASES');
        return subjectMatch || categoryMatch;
      }
      return true;
    };
    if (!branches.some(branchMatch)) return false;
    const nd = /newer_than:(\d+)d/.exec(q);
    if (nd && Number(m.internalDate) < now() - Number(nd[1]) * 86400000) return false;
    return true;
  }
  const service = {
    Users: {
      Messages: {
        list(user, opts) {
          calls.list.push(Object.assign({ user }, opts));
          if (fail.list) throw (typeof fail.list === 'function' ? fail.list() : fail.list);
          const all = [...store.values()].filter((m) => matches(m, opts.q))
            .sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
          const start = opts.pageToken ? Number(opts.pageToken) : 0;
          const max = opts.maxResults || 100;
          const page = all.slice(start, start + max);
          const out = { resultSizeEstimate: all.length };
          if (page.length) out.messages = page.map((m) => ({ id: m.id, threadId: m.threadId }));
          if (start + max < all.length) out.nextPageToken = String(start + max);
          return out;
        },
        get(user, id, opts) {
          calls.get.push({ user, id, opts });
          if (fail.get) {
            const e = typeof fail.get === 'function' ? fail.get(id) : fail.get;
            if (e) throw e;
          }
          const m = store.get(id);
          if (!m) throw new Error('Requested entity was not found.');
          return JSON.parse(JSON.stringify(m));
        }
      }
    }
  };
  return { service, calls, fail, add: (m) => store.set(m.id, m), store };
}

/** 测试用的“内存 client”（receipt_pipeline.js 的 client 接口），直接用简化的邮件对象。 */
function memoryClient(g, messages, { pageSize } = {}) {
  const calls = { list: [], get: [] };
  const fail = { list: null, get: null };
  const byId = new Map(messages.map((m) => [m.id, m]));
  return {
    calls, fail,
    list(q, token, max) {
      calls.list.push({ q, token, max });
      if (fail.list) throw fail.list;
      const ids = messages.map((m) => m.id);
      const size = pageSize || max;
      const start = token ? Number(token) : 0;
      return { ids: ids.slice(start, start + size), nextPageToken: start + size < ids.length ? String(start + size) : null };
    },
    get(id) {
      calls.get.push(id);
      if (fail.get) { const e = typeof fail.get === 'function' ? fail.get(id) : fail.get; if (e) throw e; }
      return byId.get(id);
    }
  };
}

module.exports = { apiMessage, fakeGmail, memoryClient };
