import { Bot, InlineKeyboard, InputFile, session } from 'grammy';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { db, getSetting, getTenantSetting, getDefaultTenantId } from './db.js';

const DEPARTMENTS = ['Customer Service', 'Finance', 'Captain', 'SEO Marketing', 'Social Media Marketing', 'CRM', 'Telemarketing'];
const CATEGORIES = [{ key: 'indonesian', label: 'Indonesian' }, { key: 'local', label: 'Cambodian' }];

let currentBot = null;
let currentInfo = null;
let currentToken = null;

function readConfig(tenantId) {
  const tid = tenantId || getDefaultTenantId();
  const cfg = (tid ? getTenantSetting(tid, 'bot_config', {}) : getSetting('bot_config', {})) || {};
  // Priority: env var > DB setting. Env vars in Railway survive DB resets.
  return {
    token: (process.env.BOT_TOKEN || cfg.bot_token || '').trim() || null,
    monitorGroupId: (process.env.MONITOR_GROUP_CHAT_ID || cfg.monitor_group_chat_id || '').toString().trim() || null,
    miniappUrl: (process.env.MINIAPP_URL || cfg.miniapp_url || '').trim() || 'http://localhost:5173/miniapp',
  };
}

function openMiniAppKeyboard() {
  const { miniappUrl } = readConfig();
  return new InlineKeyboard().webApp('⚡ Open WMS', miniappUrl);
}

function findStaffByTelegramId(tgId) {
  return db.prepare('SELECT * FROM staff WHERE telegram_id = ?').get(String(tgId));
}

function getAdminChatIds() {
  const env = process.env.TELEGRAM_ADMIN_CHAT_IDS;
  if (env) return env.split(',').map((s) => s.trim()).filter(Boolean);
  return (getSetting('telegram_admin_chat_ids', []) || []).map(String);
}

function isAdmin(tgId) {
  return getAdminChatIds().includes(String(tgId));
}

function attachHandlers(bot) {
  bot.use(session({ initial: () => ({ step: null, form: {} }) }));

  bot.command('start', async (ctx) => {
    const payload = ctx.match;
    if (payload && payload.startsWith('qr_')) return handleQrScan(ctx, payload);

    const staff = findStaffByTelegramId(ctx.from.id);
    if (staff && staff.is_approved) {
      return ctx.reply(`Hi ${staff.name}! Tap below to open WMS.`, { reply_markup: openMiniAppKeyboard() });
    }
    if (staff && !staff.is_approved) {
      return ctx.reply(`⏳ Halo ${staff.name}, akun Anda menunggu persetujuan admin.`);
    }
    ctx.session.step = 'pin';
    ctx.session.form = {};
    await ctx.reply('👋 Selamat datang di *Attendance*.\n\nMasukkan *PIN registrasi* untuk mulai mendaftar:', { parse_mode: 'Markdown' });
  });

  bot.on('message:text', async (ctx) => {
    const txt = ctx.message.text.trim();
    const s = ctx.session;
    const existing = findStaffByTelegramId(ctx.from.id);
    if (existing && existing.is_approved && !s.step) {
      return ctx.reply('Tap below to open WMS.', { reply_markup: openMiniAppKeyboard() });
    }

    if (s.step === 'pin') {
      const expected = String(process.env.REGISTRATION_PIN || getSetting('registration_pin', '1234'));
      if (txt !== expected) return ctx.reply('❌ PIN salah. Coba lagi atau hubungi admin.');
      s.step = 'name';
      return ctx.reply('✅ PIN benar.\n\nMasukkan *nama lengkap* Anda:', { parse_mode: 'Markdown' });
    }

    if (s.step === 'name') {
      if (txt.length < 2) return ctx.reply('Nama terlalu pendek. Coba lagi.');
      s.form.name = txt;
      s.step = 'category';
      const list = CATEGORIES.map((c, i) => `${i + 1} ${c.label}`).join('\n');
      return ctx.reply(`👤 *Pilih kategori:*\n${list}\n\nKetik nomornya:`, { parse_mode: 'Markdown' });
    }

    if (s.step === 'category') {
      const idx = parseInt(txt) - 1;
      if (isNaN(idx) || !CATEGORIES[idx]) return ctx.reply('Pilihan tidak valid. Ketik 1 atau 2.');
      s.form.category = CATEGORIES[idx].key;
      s.form.category_label = CATEGORIES[idx].label;
      s.step = 'department';
      const list = DEPARTMENTS.map((d, i) => `${i + 1} ${d}`).join('\n');
      return ctx.reply(`🏢 *Pilih department:*\n${list}\n\nKetik nomornya:`, { parse_mode: 'Markdown' });
    }

    if (s.step === 'department') {
      const idx = parseInt(txt) - 1;
      if (isNaN(idx) || !DEPARTMENTS[idx]) return ctx.reply(`Pilihan tidak valid. Ketik 1-${DEPARTMENTS.length}.`);
      s.form.department = DEPARTMENTS[idx];
      s.step = 'confirm';
      return ctx.reply(
        `📋 *Confirm Registration:*\n\n👤 Name: ${s.form.name}\n🌏 Category: ${s.form.category_label}\n🏢 Department: ${s.form.department}\n\nType *YES* to confirm or *NO* to cancel.`,
        { parse_mode: 'Markdown' }
      );
    }

    if (s.step === 'confirm') {
      const ans = txt.toLowerCase();
      if (ans === 'no' || ans === 'n' || ans === 'cancel') {
        ctx.session = { step: null, form: {} };
        return ctx.reply('❌ Registrasi dibatalkan. Ketik /start untuk mulai lagi.');
      }
      if (ans !== 'yes' && ans !== 'y') return ctx.reply('Ketik *YES* atau *NO*.', { parse_mode: 'Markdown' });

      const today = new Date().toISOString().slice(0, 10);
      const ins = db.prepare(`INSERT INTO staff(name,category,current_shift,department,telegram_id,telegram_username,join_date,is_active,is_approved)
                  VALUES(?,?,?,?,?,?,?,1,0)`)
        .run(s.form.name, s.form.category, 'morning', s.form.department, String(ctx.from.id), ctx.from.username || null, today);
      const newStaffId = ins.lastInsertRowid;

      ctx.session = { step: null, form: {} };
      await ctx.reply(
        `✅ *Registration successful!*\n\nYour account has been submitted for admin approval.\n\n⏳ Please wait for the approval notification.\nOnce approved, tap ⚡ *Open WMS* below to START.`,
        { parse_mode: 'Markdown', reply_markup: openMiniAppKeyboard() }
      );

      const muted = (getSetting('notification_prefs', {}) || {}).muted_types || [];
      if (!muted.includes('new_registration')) {
        const kb = new InlineKeyboard()
          .text('✅ Approve', `approve_${newStaffId}`)
          .text('❌ Reject', `reject_${newStaffId}`);
        const tgUser = ctx.from.username ? `@${ctx.from.username}` : `id ${ctx.from.id}`;
        const text = `🆕 *New registration:*\n👤 ${s.form.name}\n🌏 ${s.form.category_label}\n🏢 ${s.form.department}\n💬 ${tgUser}`;
        for (const chatId of getAdminChatIds()) {
          try {
            await bot.api.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb });
          } catch (e) { console.warn('[bot] notify admin failed:', e.message); }
        }
      }
    }
  });

  bot.callbackQuery(/^approve_(\d+)$/, async (ctx) => {
    const staffId = parseInt(ctx.match[1]);
    if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: '⛔ Unauthorized', show_alert: true });
    const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(staffId);
    if (!staff) return ctx.answerCallbackQuery({ text: 'Staff tidak ditemukan', show_alert: true });
    if (staff.is_approved) return ctx.answerCallbackQuery({ text: 'Sudah di-approve sebelumnya', show_alert: true });
    db.prepare('UPDATE staff SET is_approved = 1 WHERE id = ?').run(staffId);
    if (staff.telegram_id) await notifyApproved(staff.telegram_id, staff.name);
    const by = ctx.from.first_name || ctx.from.username || ctx.from.id;
    await ctx.editMessageText(`✅ *${staff.name}* APPROVED\n_oleh ${by}_`, { parse_mode: 'Markdown' });
    await ctx.answerCallbackQuery({ text: '✅ Approved!' });
  });

  bot.callbackQuery(/^reject_(\d+)$/, async (ctx) => {
    const staffId = parseInt(ctx.match[1]);
    if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: '⛔ Unauthorized', show_alert: true });
    const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(staffId);
    if (!staff) return ctx.answerCallbackQuery({ text: 'Staff tidak ditemukan', show_alert: true });
    db.prepare('UPDATE staff SET is_active = 0 WHERE id = ?').run(staffId);
    if (staff.telegram_id) {
      try {
        await bot.api.sendMessage(staff.telegram_id, `❌ Maaf ${staff.name}, registrasi Anda *ditolak* oleh admin.\n\nHubungi admin untuk info lebih lanjut.`, { parse_mode: 'Markdown' });
      } catch {}
    }
    const by = ctx.from.first_name || ctx.from.username || ctx.from.id;
    await ctx.editMessageText(`❌ *${staff.name}* REJECTED\n_oleh ${by}_`, { parse_mode: 'Markdown' });
    await ctx.answerCallbackQuery({ text: '❌ Rejected' });
  });

  bot.catch((err) => console.error('[bot] error:', err.error?.message || err));
}

async function handleQrScan(ctx, payload) {
  const m = payload.match(/^qr_(\d+)_([a-f0-9]+)$/);
  if (!m) return ctx.reply('❌ QR tidak valid.');
  const breakId = parseInt(m[1]);
  const token = m[2];
  const bl = db.prepare('SELECT * FROM break_log WHERE id = ?').get(breakId);
  if (!bl) return ctx.reply('❌ QR tidak ditemukan.');
  if (bl.qr_token !== token) return ctx.reply('❌ QR token tidak cocok.');
  if (bl.end_time) return ctx.reply('ℹ️ Break sudah selesai sebelumnya.');
  if (bl.qr_expires_at && new Date(bl.qr_expires_at) < new Date()) return ctx.reply('⏰ QR sudah expired. Klik *Back to Work* lagi di Mini App.', { parse_mode: 'Markdown' });

  const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(bl.staff_id);
  if (String(staff.telegram_id) !== String(ctx.from.id)) return ctx.reply('❌ QR ini bukan untuk Anda.');

  const now = new Date();
  const dur = Math.round((now - new Date(bl.start_time)) / 60000);
  const overtime = dur > (bl.limit_minutes || 9999) ? 1 : 0;
  db.prepare('UPDATE break_log SET end_time = ?, duration_minutes = ?, is_overtime = ? WHERE id = ?')
    .run(now.toISOString(), dur, overtime, breakId);
  db.prepare('UPDATE attendance SET current_status = ?, break_start = NULL, break_type = NULL, break_limit = NULL WHERE staff_id = ? AND date = ?')
    .run('working', bl.staff_id, new Date().toISOString().slice(0, 10));

  if (overtime) {
    notifyOvertime({ name: staff.name, department: staff.department }, bl.type, dur, bl.limit_minutes).catch(() => {});
  }

  return ctx.reply(`✅ Welcome back, ${staff.name}! Break: ${dur}m${overtime ? ' ⚠️ overtime' : ''}.`, { reply_markup: openMiniAppKeyboard() });
}

// ============ Public API ============
export async function reloadBot(tenantId) {
  const { token } = readConfig(tenantId);
  if (currentBot && currentToken === token) return { changed: false, ...getBotStatus() };
  if (currentBot) {
    try { await currentBot.stop(); } catch {}
    currentBot = null; currentInfo = null; currentToken = null;
  }
  if (!token) {
    console.log('[bot] no token configured');
    return { changed: true, running: false };
  }
  try {
    const newBot = new Bot(token);
    attachHandlers(newBot);
    const info = await newBot.api.getMe();
    await newBot.api.deleteWebhook({ drop_pending_updates: false });
    newBot.start({ drop_pending_updates: false, onStart: () => console.log(`[bot] @${info.username} ready`) });
    currentBot = newBot;
    currentInfo = info;
    currentToken = token;
    return { changed: true, running: true, username: info.username };
  } catch (e) {
    console.error('[bot] reload failed:', e.message);
    currentBot = null; currentInfo = null; currentToken = null;
    return { changed: true, running: false, error: e.message };
  }
}

export function getBotStatus(tenantId) {
  const cfg = readConfig(tenantId);
  return {
    running: !!currentBot,
    username: currentInfo?.username || null,
    has_token: !!currentToken,
    monitor_group_set: !!cfg.monitorGroupId,
    miniapp_url: cfg.miniappUrl,
  };
}

async function notifyMonitor(text) {
  if (!currentBot) return;
  const { monitorGroupId } = readConfig();
  if (!monitorGroupId) return;
  try {
    await currentBot.api.sendMessage(monitorGroupId, text, { parse_mode: 'Markdown' });
  } catch (e) { console.warn('[bot] notifyMonitor failed:', e.message); }
}

export async function notifyLate(staff, lateMin, shift) {
  const muted = (getSetting('notification_prefs', {}) || {}).muted_types || [];
  if (muted.includes('late')) return;
  const dept = staff.department ? ` · ${staff.department}` : '';
  await notifyMonitor(`⚠️ *TELAT* — ${staff.name}${dept}\n⏱ ${lateMin} menit · shift _${shift}_`);
}

export async function notifyOvertime(staff, breakType, durationMin, limitMin) {
  const muted = (getSetting('notification_prefs', {}) || {}).muted_types || [];
  if (muted.includes('break_overtime')) return;
  const labels = { smoke: '🚬 Smoke', toilet: '🚻 Toilet', outside: '🏪 Go Out' };
  const overMin = Math.max(0, durationMin - limitMin);
  const dept = staff.department ? ` · ${staff.department}` : '';
  await notifyMonitor(
    `⏰ *OVERTIME BREAK* — ${staff.name}${dept}\n` +
    `${labels[breakType] || breakType}: *${durationMin}m* / limit ${limitMin}m\n` +
    `Lewat: *+${overMin} menit*`
  );
}

export async function notifyApproved(telegramId, name) {
  if (!currentBot || !telegramId) return;
  try {
    await currentBot.api.sendMessage(telegramId, `🎉 Halo *${name}*, akun Anda *telah disetujui*!\n\nTap ⚡ Open WMS di bawah untuk mulai bekerja.`, {
      parse_mode: 'Markdown',
      reply_markup: openMiniAppKeyboard(),
    });
  } catch (e) { console.warn('[bot] notifyApproved failed:', e.message); }
}

export async function pushBreakQRToMonitor(breakLog, staff) {
  if (!currentBot) return;
  const { monitorGroupId } = readConfig();
  if (!monitorGroupId) return;
  const me = currentInfo || (await currentBot.api.getMe());
  const deepLink = `https://t.me/${me.username}?start=qr_${breakLog.id}_${breakLog.qr_token}`;
  const png = await QRCode.toBuffer(deepLink, { width: 320, margin: 2 });
  const breakLabel = { smoke: '🚬 Smoke', toilet: '🚻 Toilet', outside: '🏪 Go Out' }[breakLog.type] || breakLog.type;
  const caption = `${breakLabel}\n👤 *${staff.name}* — ${staff.department || '-'}\n⏰ Expires in 5 min\n\nScan QR ini untuk Back-to-Work.`;
  try {
    await currentBot.api.sendPhoto(monitorGroupId, new InputFile(png, `qr-${breakLog.id}.png`), { caption, parse_mode: 'Markdown' });
  } catch (e) { console.warn('[bot] pushBreakQRToMonitor failed:', e.message); }
}

export function verifyInitData(initData) {
  const { token } = readConfig();
  if (!token || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (computed !== hash) return null;
  const userJson = params.get('user');
  if (!userJson) return null;
  try { return JSON.parse(userJson); } catch { return null; }
}

export async function startBot() {
  // Initial boot — reload from current DB settings
  return reloadBot();
}
