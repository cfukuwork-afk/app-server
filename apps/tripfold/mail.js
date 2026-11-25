// メールを転送して予定を取り込む（外部ライブラリなし）
//  - 1人ごとに「<10文字>@tripfold.net」の転送先を発行（アカウント不要。住所そのものが鍵）
//  - 25番ポートでメールを受け取り（SMTP。証明書があれば STARTTLS で暗号化）、本文を文字にして保存
//  - アプリが取りに来たら渡し、受け取ったら消す。取りに来なくても30日で消す
'use strict';
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const TOKEN_RE = /^[a-hjkmnp-z2-9]{10}$/;
const MAX_MSG = 8 * 1024 * 1024; // 1通の上限（添付込み）
const MAX_TEXT = 60 * 1000; // 保存する本文の上限
const MAX_KEEP = 60; // 1人あたり保存する通数
const KEEP_MS = 30 * 24 * 3600 * 1000;
const DOMAINS = ['tripfold.net'];

module.exports = function mail({ DATA, send, readJson, limited }) {
  const DIR = path.join(DATA, 'mail');
  fs.mkdirSync(DIR, { recursive: true });
  const file = (tok) => path.join(DIR, `${tok}.json`);
  const known = (tok) => TOKEN_RE.test(tok) && fs.existsSync(file(tok));
  const load = async (tok) => {
    try {
      return JSON.parse(await fsp.readFile(file(tok), 'utf8'));
    } catch {
      return { created: Date.now(), items: [] };
    }
  };
  const store = async (tok, doc) => {
    const tmp = file(tok) + '.' + crypto.randomBytes(4).toString('hex');
    await fsp.writeFile(tmp, JSON.stringify(doc));
    await fsp.rename(tmp, file(tok));
  };
  // 1人分の書き込みは順番に（同時に2通届いても消えないように）
  const locks = new Map();
  const withLock = (tok, fn) => {
    const prev = locks.get(tok) || Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(tok, next.catch(() => {}));
    return next;
  };

  async function deliver(tok, raw) {
    const m = parseMessage(raw);
    const item = { id: crypto.randomBytes(6).toString('hex'), at: Date.now(), from: m.from.slice(0, 200), subject: m.subject.slice(0, 300), text: m.text.slice(0, MAX_TEXT) };
    // Gmail の自動転送の確認メールは、確認用のリンクだけ取り出して渡す
    const conf = /forwarding-noreply@google\.com/i.test(m.from) ? (m.text.match(/https:\/\/mail(?:-settings)?\.google\.com\/mail\/[^\s<>"]+/) || [])[0] : undefined;
    if (conf) item.confirm = conf;
    await withLock(tok, async () => {
      const doc = await load(tok);
      doc.items = [item, ...doc.items.filter((x) => Date.now() - x.at < KEEP_MS)].slice(0, MAX_KEEP);
      doc.last = item.at;
      await store(tok, doc);
    });
    return item;
  }

  /* ---------- HTTP（アプリから） ---------- */
  async function route(req, res, p, ip) {
    if (!p.startsWith('/v1/mail')) return false;
    if (limited(ip, 'mail', 240, 60 * 60 * 1000)) return send(res, 429, { error: 'too many' }), true;
    if (req.method === 'POST' && p === '/v1/mail/register') {
      if (limited(ip, 'mailreg', 20, 24 * 3600 * 1000)) return send(res, 429, { error: 'too many' }), true;
      const b = await readJson(req);
      const tok = String(b.token || '').toLowerCase();
      if (!TOKEN_RE.test(tok)) return send(res, 400, { error: 'bad token' }), true;
      if (!fs.existsSync(file(tok))) await store(tok, { created: Date.now(), items: [] });
      return send(res, 200, { ok: true, address: `${tok}@${DOMAINS[0]}` }), true;
    }
    const m = p.match(/^\/v1\/mail\/([a-z0-9]{10})(?:\/([a-f0-9]{12}))?$/);
    if (!m || !known(m[1])) return send(res, 404, { error: 'not found' }), true;
    const tok = m[1];
    if (req.method === 'GET' && !m[2]) {
      const doc = await load(tok);
      const items = doc.items.filter((x) => Date.now() - x.at < KEEP_MS);
      return send(res, 200, { items }), true;
    }
    if (req.method === 'DELETE' && m[2]) {
      await withLock(tok, async () => {
        const doc = await load(tok);
        doc.items = doc.items.filter((x) => x.id !== m[2]);
        await store(tok, doc);
      });
      return send(res, 200, { ok: true }), true;
    }
    return send(res, 405, { error: 'method' }), true;
  }

  /* ---------- SMTP（メールの受け取り） ---------- */
  let ctx = null;
  let ctxAt = 0;
  function tlsContext() {
    // 証明書は update.sh が Caddy のものをコピーしてくる。更新されたら読み直す
    const dir = path.join(DATA, 'tls');
    try {
      const st = fs.statSync(path.join(dir, 'cert.pem'));
      if (!ctx || st.mtimeMs !== ctxAt) {
        ctx = tls.createSecureContext({ cert: fs.readFileSync(path.join(dir, 'cert.pem')), key: fs.readFileSync(path.join(dir, 'key.pem')) });
        ctxAt = st.mtimeMs;
      }
    } catch {
      ctx = null;
    }
    return ctx;
  }

  const perIp = new Map();
  function startSmtp(port, host = '0.0.0.0') {
    const srv = net.createServer((sock0) => {
      const rip = String(sock0.remoteAddress || '');
      const n = (perIp.get(rip) || 0) + 1;
      if (n > 5) return sock0.end('421 too many connections\r\n');
      perIp.set(rip, n);
      sock0.on('close', () => perIp.set(rip, (perIp.get(rip) || 1) - 1));
      session(sock0, rip);
    });
    srv.on('error', (e) => console.error('smtp', e.message));
    srv.listen(port, host, () => console.log(`tripfold mail listening on ${port}`));
    return srv;
  }

  function session(sock, rip) {
    let buf = Buffer.alloc(0);
    let mode = 'cmd';
    let rcpt = [];
    let from = '';
    let data = [];
    let size = 0;
    let secure = false;
    let cmds = 0;
    const say = (s) => sock.writable && sock.write(s + '\r\n');
    sock.setTimeout(120 * 1000, () => {
      say('421 timeout');
      sock.destroy();
    });
    sock.on('error', () => {});
    say('220 tripfold.net ESMTP');
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (mode === 'cmd' && buf.length > 4096 && buf.indexOf('\r\n') < 0) return sock.destroy();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.subarray(0, i + 1);
        buf = buf.subarray(i + 1);
        if (mode === 'data') {
          const s = line.toString('latin1');
          if (s === '.\r\n' || s === '.\n') {
            mode = 'cmd';
            const raw = Buffer.concat(data);
            data = [];
            if (size > MAX_MSG) {
              say('552 message too large');
            } else {
              Promise.all(rcpt.map((tok) => deliver(tok, raw)))
                .then(() => say('250 OK queued'))
                .catch((e) => {
                  console.error('mail deliver', e);
                  say('451 try again later');
                });
            }
            rcpt = [];
            continue;
          }
          size += line.length;
          if (size <= MAX_MSG) data.push(line[0] === 0x2e ? line.subarray(1) : line);
          continue;
        }
        if (++cmds > 200) return sock.end('421 too many commands\r\n');
        const cmd = line.toString('utf8').replace(/\r?\n$/, '');
        const verb = cmd.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') {
          const ext = ['250-tripfold.net', `250-SIZE ${MAX_MSG}`, '250-8BITMIME', '250-SMTPUTF8', '250-PIPELINING'];
          if (!secure && tlsContext()) ext.push('250-STARTTLS');
          ext.push('250 HELP');
          say(ext.join('\r\n'));
        } else if (verb === 'HELO') say('250 tripfold.net');
        else if (verb === 'STAR' && /^STARTTLS$/i.test(cmd) && !secure && tlsContext()) {
          say('220 ready');
          sock.removeListener('data', onData);
          const ts = new tls.TLSSocket(sock, { isServer: true, secureContext: tlsContext() });
          ts.on('error', () => sock.destroy());
          secure = true;
          buf = Buffer.alloc(0);
          rcpt = [];
          from = '';
          sock = ts;
          ts.on('data', onData);
          continue;
        } else if (verb === 'MAIL') {
          from = (cmd.match(/<([^>]*)>/) || [])[1] || '';
          rcpt = [];
          size = 0;
          say('250 OK');
        } else if (verb === 'RCPT') {
          const to = ((cmd.match(/<([^>]*)>/) || [])[1] || '').toLowerCase();
          const [local, dom] = to.split('@');
          if (!DOMAINS.includes(dom || '')) say('550 relay not permitted');
          else if (!known(local || '')) say('550 no such user');
          else if (rcpt.length >= 5) say('452 too many recipients');
          else {
            if (!rcpt.includes(local)) rcpt.push(local);
            say('250 OK');
          }
        } else if (verb === 'DATA') {
          if (!rcpt.length) say('554 no valid recipients');
          else {
            mode = 'data';
            size = 0;
            say('354 end with <CRLF>.<CRLF>');
          }
        } else if (verb === 'RSET') {
          rcpt = [];
          from = '';
          say('250 OK');
        } else if (verb === 'NOOP') say('250 OK');
        else if (verb === 'QUIT') {
          say('221 bye');
          sock.end();
          return;
        } else if (verb === 'VRFY') say('252 cannot verify');
        else say('502 command not implemented');
      }
    };
    sock.on('data', onData);
    void from;
    void rip;
  }

  return { route, startSmtp, deliver, parseMessage, TOKEN_RE };
};

/* ---------- メールの中身を文字にする（MIME） ---------- */
function splitHead(buf) {
  let i = buf.indexOf('\r\n\r\n');
  let skip = 4;
  if (i < 0) {
    i = buf.indexOf('\n\n');
    skip = 2;
  }
  if (i < 0) return { head: buf.toString('latin1'), body: Buffer.alloc(0) };
  return { head: buf.subarray(0, i).toString('latin1'), body: buf.subarray(i + skip) };
}
function headers(head) {
  const h = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const k = line.indexOf(':');
    if (k > 0) {
      const name = line.slice(0, k).trim().toLowerCase();
      if (!(name in h)) h[name] = line.slice(k + 1).trim();
    }
  }
  return h;
}
const param = (v, name) => {
  const m = String(v || '').match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i'));
  return m ? m[1] ?? m[2] : '';
};
function decodeBytes(bytes, charset) {
  let cs = String(charset || 'utf-8').toLowerCase().replace(/^(x-|cp)?(sjis|shift-jis|windows-31j|ms932|932)$/, 'shift_jis');
  if (cs === 'us-ascii' || cs === 'ascii') cs = 'utf-8';
  try {
    return new TextDecoder(cs).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}
function qp(s) {
  const t = s.replace(/=\r?\n/g, '');
  const out = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) {
      out.push(parseInt(t.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(t.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}
/** =?UTF-8?B?...?= のような件名・差出人を読める文字にする */
function words(s) {
  return String(s || '')
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, txt) => {
      const bytes = enc.toUpperCase() === 'B' ? Buffer.from(txt, 'base64') : qp(txt.replace(/_/g, ' '));
      return decodeBytes(bytes, cs);
    });
}
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', yen: '¥', euro: '€', pound: '£', copy: '©', reg: '®', middot: '·', ndash: '–', mdash: '—', rarr: '→' };
function htmlText(h) {
  return h
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m))
    .replace(/[ \t ]+/g, (m) => (m.includes('\t') ? '\t' : ' '))
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function partText(buf, depth = 0) {
  const { head, body } = splitHead(buf);
  const h = headers(head);
  const ct = h['content-type'] || 'text/plain';
  const type = ct.split(';')[0].trim().toLowerCase();
  if (type.startsWith('multipart/') && depth < 6) {
    const b = param(ct, 'boundary');
    if (!b) return { plain: '', html: '' };
    const parts = body.toString('latin1').split('--' + b);
    const res = { plain: '', html: '' };
    for (const p of parts.slice(1)) {
      if (p.startsWith('--')) break;
      const sub = partText(Buffer.from(p.replace(/^\r?\n/, ''), 'latin1'), depth + 1);
      // alternative は最初に見つかったものを使い、mixed（転送など）は足していく
      if (type === 'multipart/alternative') {
        res.plain ||= sub.plain;
        res.html ||= sub.html;
      } else {
        if (sub.plain) res.plain += (res.plain ? '\n\n' : '') + sub.plain;
        if (sub.html) res.html += (res.html ? '\n\n' : '') + sub.html;
      }
    }
    return res;
  }
  if (type === 'message/rfc822' && depth < 6) {
    const inner = parseMessage(body, depth + 1);
    return { plain: `${inner.subject ? 'Subject: ' + inner.subject + '\n' : ''}${inner.text}`, html: '' };
  }
  const disp = (h['content-disposition'] || '').toLowerCase();
  if (disp.startsWith('attachment') || !(type === 'text/plain' || type === 'text/html')) return { plain: '', html: '' };
  const enc = (h['content-transfer-encoding'] || '').toLowerCase();
  const bytes = enc === 'base64' ? Buffer.from(body.toString('latin1').replace(/\s+/g, ''), 'base64') : enc === 'quoted-printable' ? qp(body.toString('latin1')) : body;
  const txt = decodeBytes(bytes, param(ct, 'charset'));
  return type === 'text/html' ? { plain: '', html: txt } : { plain: txt, html: '' };
}
function parseMessage(raw, depth = 0) {
  const { head } = splitHead(raw);
  const h = headers(head);
  const t = partText(raw, depth);
  // HTMLの方が予約の表をきちんと持っていることが多いので、両方あれば長い方
  const fromHtml = t.html ? htmlText(t.html) : '';
  const plain = t.plain.replace(/\r\n/g, '\n').trim();
  const text = fromHtml.length > plain.length * 1.2 ? fromHtml : plain || fromHtml;
  return { from: words(h['from']), subject: words(h['subject']), date: h['date'] || '', text };
}
module.exports.parseMessage = parseMessage;
