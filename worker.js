// Telegram-бот-хранилище на Cloudflare Workers + D1.
// Секреты: BOT_TOKEN, OWNER_ID, PASSWORD, WEBHOOK_SECRET
// Чат остаётся чистым: твои сообщения удаляются сразу после сохранения,
// бот меняет одно сообщение-панель, показанные записи убираются кнопкой или при блокировке.

const HOUR = 3600;
const now = () => Math.floor(Date.now() / 1000);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const API = (env, method, body) =>
  fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json()).catch(() => ({ ok: false }));

const KINDS = ['photo', 'video', 'document', 'audio', 'voice', 'video_note', 'animation', 'sticker'];
const SEND = {
  photo: 'sendPhoto', video: 'sendVideo', document: 'sendDocument', audio: 'sendAudio',
  voice: 'sendVoice', video_note: 'sendVideoNote', animation: 'sendAnimation', sticker: 'sendSticker',
};

// ---------- состояние ----------
async function getState(env, uid) {
  let s = await env.DB.prepare('SELECT * FROM state WHERE user_id=?').bind(uid).first();
  if (!s) {
    await env.DB.prepare('INSERT INTO state(user_id) VALUES(?)').bind(uid).run();
    s = { user_id: uid, panel_id: null, cur: 0, active: 0, locked: 1, awaiting: null };
  }
  return s;
}
const save = (env, s) =>
  env.DB.prepare('UPDATE state SET panel_id=?, cur=?, active=?, locked=?, awaiting=? WHERE user_id=?')
    .bind(s.panel_id ?? null, s.cur, s.active, s.locked, s.awaiting ?? null, s.user_id).run();

const isLocked = (s) => s.locked || now() - s.active > HOUR;

async function clearShown(env, uid) {
  const rows = (await env.DB.prepare('SELECT msg_id FROM shown WHERE chat_id=?').bind(uid).all()).results;
  await Promise.all(rows.map((r) => API(env, 'deleteMessage', { chat_id: uid, message_id: r.msg_id })));
  await env.DB.prepare('DELETE FROM shown WHERE chat_id=?').bind(uid).run();
}

// ---------- панель ----------
async function show(env, s, text, kb) {
  const body = { chat_id: s.user_id, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } };
  if (s.panel_id) {
    const r = await API(env, 'editMessageText', { ...body, message_id: s.panel_id });
    if (r.ok || /not modified/.test(r.description || '')) return;
    await API(env, 'deleteMessage', { chat_id: s.user_id, message_id: s.panel_id });
  }
  const r = await API(env, 'sendMessage', body);
  if (r.ok) {
    s.panel_id = r.result.message_id;
    await save(env, s);
  }
}

// Переносит панель вниз чата (после показа записей)
async function resetPanel(env, s) {
  if (s.panel_id) await API(env, 'deleteMessage', { chat_id: s.user_id, message_id: s.panel_id });
  s.panel_id = null;
}

const lockScreen = (env, s) => show(env, s, '🔒 <b>Заблокировано</b>\nОтправь пароль.', []);

async function pathOf(env, id) {
  const parts = [];
  for (let i = 0; i < 12 && id; i++) {
    const f = await env.DB.prepare('SELECT name, parent_id FROM folders WHERE id=?').bind(id).first();
    if (!f) break;
    parts.unshift(f.name);
    id = f.parent_id;
  }
  return ['Главная', ...parts].join(' / ');
}

async function panel(env, s, opts = {}) {
  const subs = (await env.DB.prepare('SELECT id, name FROM folders WHERE parent_id=? ORDER BY name').bind(s.cur).all()).results;
  const cnt = (await env.DB.prepare('SELECT COUNT(*) c FROM items WHERE folder_id=?').bind(s.cur).first()).c;
  const shownCnt = (await env.DB.prepare('SELECT COUNT(*) c FROM shown WHERE chat_id=?').bind(s.user_id).first()).c;

  let text = `📁 <b>${esc(await pathOf(env, s.cur))}</b>\nЗаписей: ${cnt}`;
  if (s.awaiting === 'new') text += '\n\n✏️ Пришли название нового раздела';
  if (s.awaiting === 'ren') text += '\n\n✏️ Пришли новое название';
  if (opts.note) text += `\n\n${opts.note}`;

  const kb = [];
  for (let i = 0; i < subs.length; i += 2)
    kb.push(subs.slice(i, i + 2).map((f) => ({ text: '📂 ' + f.name, callback_data: 'f:' + f.id })));

  if (s.awaiting) {
    kb.push([{ text: '✖ Отмена', callback_data: 'cancel' }]);
  } else {
    const row = [{ text: '➕ Раздел', callback_data: 'nf' }];
    if (cnt) row.push({ text: `📄 Показать (${cnt})`, callback_data: 's:0' });
    kb.push(row);
    if (opts.more != null) kb.push([{ text: '▶ Ещё', callback_data: 's:' + opts.more }]);
    if (shownCnt) kb.push([{ text: '🧹 Убрать показанное', callback_data: 'clr' }]);
    const row2 = [];
    if (s.cur) row2.push({ text: '⬆️ Назад', callback_data: 'up' }, { text: '✏️', callback_data: 'rn' }, { text: '🗑', callback_data: 'df' });
    row2.push({ text: '🔒', callback_data: 'lock' });
    kb.push(row2);
  }
  await show(env, s, text, kb);
}

// ---------- записи ----------
function extract(m) {
  let kind = null, file_id = null, text = null, caption = m.caption || null;
  if (m.photo) { kind = 'photo'; file_id = m.photo[m.photo.length - 1].file_id; }
  else for (const k of KINDS) if (m[k]) { kind = k; file_id = m[k].file_id; break; }
  if (!kind) {
    if (!m.text) return null;
    kind = 'text'; text = m.text;
  }
  // источник из пересланного поста канала
  const fo = m.forward_origin;
  if (fo && fo.type === 'channel' && fo.chat) {
    const link = fo.chat.username
      ? `https://t.me/${fo.chat.username}/${fo.message_id}`
      : `https://t.me/c/${String(fo.chat.id).replace('-100', '')}/${fo.message_id}`;
    if (kind === 'text') text += '\n\n🔗 ' + link;
    else caption = ((caption ? caption + '\n' : '') + '🔗 ' + link).slice(0, 1024);
  }
  return { kind, file_id, text, caption };
}

async function sendItem(env, uid, it) {
  const kb = { inline_keyboard: [[
    { text: '✖ Закрыть', callback_data: 'x' },
    { text: '🗑 Удалить', callback_data: 'di:' + it.id },
  ]] };
  // protect_content не задан, значит пересылка разрешена
  const r = it.kind === 'text'
    ? await API(env, 'sendMessage', { chat_id: uid, text: it.text, reply_markup: kb })
    : await API(env, SEND[it.kind], { chat_id: uid, [it.kind]: it.file_id, caption: it.caption || undefined, reply_markup: kb });
  if (r.ok) await env.DB.prepare('INSERT OR REPLACE INTO shown(msg_id, chat_id) VALUES(?,?)').bind(r.result.message_id, uid).run();
}

async function deleteFolderTree(env, id) {
  const ids = (await env.DB.prepare(
    'WITH RECURSIVE t(id) AS (SELECT ?1 UNION ALL SELECT f.id FROM folders f JOIN t ON f.parent_id=t.id) SELECT id FROM t'
  ).bind(id).all()).results.map((r) => r.id);
  const ph = ids.map(() => '?').join(',');
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM items WHERE folder_id IN (${ph})`).bind(...ids),
    env.DB.prepare(`DELETE FROM folders WHERE id IN (${ph})`).bind(...ids),
  ]);
}

// ---------- сообщения ----------
async function onMessage(env, m) {
  if (m.chat.type !== 'private') return;
  const uid = m.from.id;
  const s = await getState(env, uid);
  const del = () => API(env, 'deleteMessage', { chat_id: uid, message_id: m.message_id });

  if (isLocked(s)) {
    if (!s.locked) await clearShown(env, uid);
    if (m.text && m.text === env.PASSWORD) {
      s.locked = 0; s.active = now(); s.awaiting = null;
      await save(env, s); await del(); await panel(env, s);
    } else {
      s.locked = 1; s.awaiting = null;
      await save(env, s); await del(); await lockScreen(env, s);
    }
    return;
  }

  s.active = now();
  const name = (m.text || '').trim().slice(0, 40);

  if (m.text === '/start') {
    s.awaiting = null; await save(env, s); await del(); await panel(env, s); return;
  }
  if (s.awaiting === 'new' && name) {
    await env.DB.prepare('INSERT INTO folders(parent_id, name) VALUES(?,?)').bind(s.cur, name).run();
    s.awaiting = null; await save(env, s); await del(); await panel(env, s, { note: '✅ Раздел создан' }); return;
  }
  if (s.awaiting === 'ren' && name && s.cur) {
    await env.DB.prepare('UPDATE folders SET name=? WHERE id=?').bind(name, s.cur).run();
    s.awaiting = null; await save(env, s); await del(); await panel(env, s, { note: '✅ Переименовано' }); return;
  }

  const it = extract(m);
  if (!it) { await save(env, s); await del(); await panel(env, s, { note: '⚠️ Этот тип не сохраняется' }); return; }
  await env.DB.prepare('INSERT INTO items(folder_id, kind, file_id, text, caption, created) VALUES(?,?,?,?,?,?)')
    .bind(s.cur, it.kind, it.file_id, it.text, it.caption, now()).run();
  await save(env, s);
  await del();
  await panel(env, s, { note: '✅ Сохранено' });
}

// ---------- кнопки ----------
async function onCallback(env, q) {
  const uid = q.from.id;
  const s = await getState(env, uid);
  const ack = (text) => API(env, 'answerCallbackQuery', { callback_query_id: q.id, text });

  if (isLocked(s)) {
    await ack();
    await clearShown(env, uid);
    s.locked = 1; await save(env, s); await lockScreen(env, s);
    return;
  }
  s.active = now();
  const d = q.data || '';
  const mid = q.message && q.message.message_id;

  if (d === 'x') {
    await ack();
    await API(env, 'deleteMessage', { chat_id: uid, message_id: mid });
    await env.DB.prepare('DELETE FROM shown WHERE msg_id=?').bind(mid).run();
    await save(env, s); return;
  }
  if (d.startsWith('di:')) {
    await env.DB.prepare('DELETE FROM items WHERE id=?').bind(Number(d.slice(3))).run();
    await ack('Удалено');
    await API(env, 'deleteMessage', { chat_id: uid, message_id: mid });
    await env.DB.prepare('DELETE FROM shown WHERE msg_id=?').bind(mid).run();
    await save(env, s); return;
  }

  await ack();
  if (d.startsWith('f:')) { s.cur = Number(d.slice(2)); s.awaiting = null; }
  else if (d === 'up') {
    const f = await env.DB.prepare('SELECT parent_id FROM folders WHERE id=?').bind(s.cur).first();
    s.cur = f ? f.parent_id : 0; s.awaiting = null;
  }
  else if (d === 'nf') s.awaiting = 'new';
  else if (d === 'rn' && s.cur) s.awaiting = 'ren';
  else if (d === 'cancel') s.awaiting = null;
  else if (d === 'clr') await clearShown(env, uid);
  else if (d === 'lock') {
    await clearShown(env, uid);
    s.locked = 1; s.awaiting = null; await save(env, s); await lockScreen(env, s); return;
  }
  else if (d === 'df' && s.cur) {
    await save(env, s);
    await show(env, s, `🗑 Удалить раздел <b>${esc(await pathOf(env, s.cur))}</b> со всем содержимым?`, [[
      { text: '✅ Да', callback_data: 'dfc' }, { text: '✖ Нет', callback_data: 'cancel' },
    ]]);
    return;
  }
  else if (d === 'dfc' && s.cur) {
    const f = await env.DB.prepare('SELECT parent_id FROM folders WHERE id=?').bind(s.cur).first();
    await deleteFolderTree(env, s.cur);
    s.cur = f ? f.parent_id : 0;
  }
  else if (d.startsWith('s:')) {
    const off = Number(d.slice(2));
    const rows = (await env.DB.prepare('SELECT * FROM items WHERE folder_id=? ORDER BY id LIMIT 11 OFFSET ?').bind(s.cur, off).all()).results;
    for (const it of rows.slice(0, 10)) await sendItem(env, uid, it);
    await resetPanel(env, s);
    await save(env, s);
    await panel(env, s, { more: rows.length > 10 ? off + 10 : null });
    return;
  }

  await save(env, s);
  await panel(env, s);
}

export default {
  async fetch(req, env, ctx) {
    if (req.method !== 'POST') return new Response('ok');
    if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('no', { status: 403 });
    const u = await req.json();
    const from = (u.message || u.callback_query || {}).from;
    if (!from || String(from.id) !== String(env.OWNER_ID)) return new Response('ok');
    ctx.waitUntil((async () => {
      try {
        if (u.message) await onMessage(env, u.message);
        else if (u.callback_query) await onCallback(env, u.callback_query);
      } catch (e) { console.error(e); }
    })());
    return new Response('ok');
  },

  // Каждые 10 минут: блокирует по таймеру и убирает показанные записи
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const rows = (await env.DB.prepare('SELECT * FROM state WHERE locked=0 AND active<?').bind(now() - HOUR).all()).results;
      for (const s of rows) {
        await clearShown(env, s.user_id);
        s.locked = 1; s.awaiting = null;
        await save(env, s);
        await lockScreen(env, s);
      }
    })());
  },
};
