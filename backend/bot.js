import { Bot, InlineKeyboard, InputFile, session } from 'grammy';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { db, getTenantSetting, getDefaultTenantId } from './db.js';
import { emitLiveUpdate } from './events.js';

const DEPARTMENTS = ['Customer Service', 'Finance', 'Captain', 'SEO Marketing', 'Social Media Marketing', 'CRM', 'Telemarketing'];
const CATEGORIES = [{ key: 'indonesian', label: 'Indonesian' }, { key: 'local', label: 'Cambodian' }];

// Map tenant_id → { bot, info, token }
const runningBots = new Map();

function readTenantConfig(tenantId) {
  const cfg = getTenantSetting(tenantId, 'bot_config', {}) || {};
  // Env vars only apply to default tenant (backward compat)
  const isDefault = tenantId === getDefaultTenantId();
  return {
    tenantId,
    token: ((isDefault && process.env.BOT_TOKEN) || cfg.bot_token || '').trim() || null,
    monitorGroupId: ((isDefault && process.env.MONITOR_GROUP_CHAT_ID) || cfg.monitor_group_chat_id || '').toString().trim() || null,
    miniappUrl: ((isDefault && process.env.MINIAPP_URL) || cfg.miniapp_url || '').trim() || 'http://localhost:5173/miniapp',
  };
}

function openMiniAppKeyboard(tenantId) {
  const { miniappUrl } = readTenantConfig(tenantId);
  return new InlineKeyboard().webApp('⚡ Open WMS', miniappUrl);
}

function findStaffByTelegramId(tenantId, tgId) {
  return db.prepare('SELECT * FROM staff WHERE tenant_id = ? AND telegram_id = ?').get(tenantId, String(tgId));
}

function getAdminChatIds(tenantId) {
  // For default tenant, also check env
  if (tenantId === getDefaultTenantId() && process.env.TELEGRAM_ADMIN_CHAT_IDS) {
    return process.env.TELEGRAM_ADMIN_CHAT_IDS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return (getTenantSetting(tenantId, 'telegram_admin_chat_ids', []) || []).map(String);
}

function isAdmin(tenantId, tgId) {
  return getAdminChatIds(tenantId).includes(String(tgId));
}

function getRegistrationPin(tenantId) {
  if (tenantId === getDefaultTenantId() && process.env.REGISTRATION_PIN) return process.env.REGISTRATION_PIN;
  return String(getTenantSetting(tenantId, 'registration_pin', '1234'));
}

function attachHandlers(bot, tenantId) {
  bot.use(session({ initial: () => ({ step: null, form: {} }) }));

  bot.command('start', async (ctx) => {
    const payload = ctx.match;
    if (payload && payload.startsWith('qr_')) return handleQrScan(ctx, tenantId, payload);

    const staff = findStaffByTelegramId(tenantId, ctx.from.id);
    if (staff && staff.is_approved) {
      return ctx.reply(`Hi ${staff.name}! Tap below to open WMS.`, { reply_markup: openMiniAppKeyboard(tenantId) });
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
    const existing = findStaffByTelegramId(tenantId, ctx.from.id);
    if (existing && existing.is_approved && !s.step) {
      return ctx.reply('Tap below to open WMS.', { reply_markup: openMiniAppKeyboard(tenantId) });
    }

    if (s.step === 'pin') {
      const expected = getRegistrationPin(tenantId);
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
      // Resolve department_id (find or create)
      let deptId = null;
      if (s.form.department) {
        const dRow = db.prepare('SELECT id FROM departments WHERE tenant_id = ? AND LOWER(name) = LOWER(?)').get(tenantId, s.form.department);
        if (dRow) deptId = dRow.id;
        else {
          const slug = String(s.form.department).toLowerCase().replace(/[^a-z0-9]+/g, '_');
          const dr = db.prepare('INSERT INTO departments(tenant_id,name,slug) VALUES(?,?,?)').run(tenantId, s.form.department, slug);
          deptId = dr.lastInsertRowid;
        }
      }
      const ins = db.prepare(`INSERT INTO staff(tenant_id,name,category,current_shift,department,department_id,telegram_id,telegram_username,join_date,is_active,is_approved)
                  VALUES(?,?,?,?,?,?,?,?,?,1,0)`)
        .run(tenantId, s.form.name, s.form.category, 'morning', s.form.department, deptId, String(ctx.from.id), ctx.from.username || null, today);
      const newStaffId = ins.lastInsertRowid;

      ctx.session = { step: null, form: {} };
      await ctx.reply(
        `✅ *Registration successful!*\n\nYour account has been submitted for admin approval.\n\n⏳ Please wait for the approval notification.\nOnce approved, tap ⚡ *Open WMS* below to START.`,
        { parse_mode: 'Markdown', reply_markup: openMiniAppKeyboard(tenantId) }
      );

      const muted = (getTenantSetting(tenantId, 'notification_prefs', {}) || {}).muted_types || [];
      if (!muted.includes('new_registration')) {
        const kb = new InlineKeyboard()
          .text('✅ Approve', `approve_${newStaffId}`)
          .text('❌ Reject', `reject_${newStaffId}`);
        const tgUser = ctx.from.username ? `@${ctx.from.username}` : `id ${ctx.from.id}`;
        const mention = buildHeadMention(deptId);
        const text = `${mention}🆕 *New registration:*\n👤 ${s.form.name}\n🌏 ${s.form.category_label}\n🏢 ${s.form.department}\n💬 ${tgUser}`;
        // Kirim ke dept group (kalau ada) — kalau tidak ada, fallback ke admin chat IDs (legacy)
        const deptChatId = resolveTargetChatId(tenantId, deptId);
        const dept = getDeptInfo(deptId);
        if (deptId && dept?.monitor_group_chat_id) {
          try { await bot.api.sendMessage(deptChatId, text, { parse_mode: 'Markdown', reply_markup: kb }); }
          catch (e) { console.warn('[bot] notify dept group failed:', e.message); }
        } else {
          for (const chatId of getAdminChatIds(tenantId)) {
            try { await bot.api.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb }); }
            catch (e) { console.warn('[bot] notify admin failed:', e.message); }
          }
          // Juga kirim ke tenant monitor group kalau di-set
          if (deptChatId) {
            try { await bot.api.sendMessage(deptChatId, text, { parse_mode: 'Markdown', reply_markup: kb }); }
            catch (e) {}
          }
        }
      }
    }
  });

  bot.callbackQuery(/^approve_(\d+)$/, async (ctx) => {
    const staffId = parseInt(ctx.match[1]);
    if (!isAdmin(tenantId, ctx.from.id)) return ctx.answerCallbackQuery({ text: '⛔ Unauthorized', show_alert: true });
    const staff = db.prepare('SELECT * FROM staff WHERE id = ? AND tenant_id = ?').get(staffId, tenantId);
    if (!staff) return ctx.answerCallbackQuery({ text: 'Staff tidak ditemukan', show_alert: true });
    if (staff.is_approved) return ctx.answerCallbackQuery({ text: 'Sudah di-approve sebelumnya', show_alert: true });
    db.prepare('UPDATE staff SET is_approved = 1 WHERE id = ?').run(staffId);
    if (staff.telegram_id) await notifyApproved(tenantId, staff.telegram_id, staff.name);
    emitLiveUpdate(tenantId, 'staff_approved_bot', { staff_id: staffId });
    const by = ctx.from.first_name || ctx.from.username || ctx.from.id;
    await ctx.editMessageText(`✅ *${staff.name}* APPROVED\n_oleh ${by}_`, { parse_mode: 'Markdown' });
    await ctx.answerCallbackQuery({ text: '✅ Approved!' });
  });

  bot.callbackQuery(/^swap_approve_(\d+)$/, async (ctx) => {
    const swapId = parseInt(ctx.match[1]);
    if (!isAdmin(tenantId, ctx.from.id)) return ctx.answerCallbackQuery({ text: '⛔ Unauthorized', show_alert: true });
    const sw = db.prepare('SELECT * FROM swap_requests WHERE id = ? AND tenant_id = ?').get(swapId, tenantId);
    if (!sw) return ctx.answerCallbackQuery({ text: 'Swap tidak ditemukan', show_alert: true });
    if (sw.status !== 'pending') return ctx.answerCallbackQuery({ text: 'Sudah diproses sebelumnya', show_alert: true });
    // Apply schedule update
    if (sw.target_staff_id) {
      const partnerDate = sw.partner_date || sw.target_date;
      const reqSched = db.prepare('SELECT shift FROM schedule_daily WHERE staff_id = ? AND date = ?').get(sw.requester_id, sw.target_date);
      const partnerSched = db.prepare('SELECT shift FROM schedule_daily WHERE staff_id = ? AND date = ?').get(sw.target_staff_id, partnerDate);
      if (!reqSched || !partnerSched) return ctx.answerCallbackQuery({ text: 'Schedule sudah berubah', show_alert: true });
      db.transaction(() => {
        db.prepare('UPDATE schedule_daily SET shift = ?, is_manual_override = 1 WHERE staff_id = ? AND date = ?').run(partnerSched.shift, sw.requester_id, sw.target_date);
        db.prepare('UPDATE schedule_daily SET shift = ?, is_manual_override = 1 WHERE staff_id = ? AND date = ?').run(reqSched.shift, sw.target_staff_id, partnerDate);
      })();
    } else {
      db.prepare(`INSERT INTO schedule_daily(tenant_id,staff_id,date,status,shift,is_manual_override) VALUES(?,?,?,'off','morning',1)
                  ON CONFLICT(staff_id,date) DO UPDATE SET status='off', is_manual_override=1`)
        .run(sw.tenant_id, sw.requester_id, sw.target_date);
    }
    db.prepare('UPDATE swap_requests SET status = ? WHERE id = ?').run('approved', swapId);
    emitLiveUpdate(tenantId, 'swap_approved', { swap_id: swapId });
    // Notify requester
    const requester = db.prepare('SELECT name, telegram_id FROM staff WHERE id = ?').get(sw.requester_id);
    if (requester?.telegram_id) {
      const typeLabel = sw.target_staff_id ? 'Swap (Trade)' : 'Request OFF';
      try { await bot.api.sendMessage(requester.telegram_id, `✅ *${typeLabel}* untuk *${sw.target_date}* di-approve!`, { parse_mode: 'Markdown', reply_markup: openMiniAppKeyboard(tenantId) }); } catch {}
    }
    const by = ctx.from.first_name || ctx.from.username || ctx.from.id;
    await ctx.editMessageText(`✅ *Swap APPROVED*\n_oleh ${by}_`, { parse_mode: 'Markdown' });
    await ctx.answerCallbackQuery({ text: '✅ Approved!' });
  });

  bot.callbackQuery(/^swap_reject_(\d+)$/, async (ctx) => {
    const swapId = parseInt(ctx.match[1]);
    if (!isAdmin(tenantId, ctx.from.id)) return ctx.answerCallbackQuery({ text: '⛔ Unauthorized', show_alert: true });
    const sw = db.prepare('SELECT * FROM swap_requests WHERE id = ? AND tenant_id = ?').get(swapId, tenantId);
    if (!sw) return ctx.answerCallbackQuery({ text: 'Swap tidak ditemukan', show_alert: true });
    if (sw.status !== 'pending') return ctx.answerCallbackQuery({ text: 'Sudah diproses', show_alert: true });
    db.prepare('UPDATE swap_requests SET status = ?, reject_reason = ? WHERE id = ?').run('rejected', '', swapId);
    const requester = db.prepare('SELECT name, telegram_id FROM staff WHERE id = ?').get(sw.requester_id);
    if (requester?.telegram_id) {
      try { await bot.api.sendMessage(requester.telegram_id, `❌ Swap request Anda untuk ${sw.target_date} *ditolak* oleh admin.`, { parse_mode: 'Markdown' }); } catch {}
    }
    const by = ctx.from.first_name || ctx.from.username || ctx.from.id;
    await ctx.editMessageText(`❌ *Swap REJECTED*\n_oleh ${by}_`, { parse_mode: 'Markdown' });
    await ctx.answerCallbackQuery({ text: '❌ Rejected' });
  });

  bot.callbackQuery(/^reject_(\d+)$/, async (ctx) => {
    const staffId = parseInt(ctx.match[1]);
    if (!isAdmin(tenantId, ctx.from.id)) return ctx.answerCallbackQuery({ text: '⛔ Unauthorized', show_alert: true });
    const staff = db.prepare('SELECT * FROM staff WHERE id = ? AND tenant_id = ?').get(staffId, tenantId);
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

async function handleQrScan(ctx, tenantId, payload) {
  const m = payload.match(/^qr_(\d+)_([a-f0-9]+)$/);
  if (!m) return ctx.reply('❌ QR tidak valid.');
  const breakId = parseInt(m[1]);
  const token = m[2];
  const bl = db.prepare('SELECT * FROM break_log WHERE id = ? AND tenant_id = ?').get(breakId, tenantId);
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
    notifyOvertime(tenantId, { name: staff.name, department: staff.department }, bl.type, dur, bl.limit_minutes).catch(() => {});
  }

  emitLiveUpdate(tenantId, 'break_end_qr_bot', { staff_id: bl.staff_id });
  return ctx.reply(`✅ Welcome back, ${staff.name}! Break: ${dur}m${overtime ? ' ⚠️ overtime' : ''}.`, { reply_markup: openMiniAppKeyboard(tenantId) });
}

// ============ Public API ============
async function stopTenantBot(tenantId) {
  const entry = runningBots.get(tenantId);
  if (!entry) return;
  try { await entry.bot.stop(); } catch {}
  runningBots.delete(tenantId);
}

export async function reloadBot(tenantId) {
  const tid = tenantId || getDefaultTenantId();
  if (!tid) return { running: false, error: 'No tenant' };
  const { token } = readTenantConfig(tid);
  const existing = runningBots.get(tid);

  if (existing && existing.token === token) return { changed: false, running: true, username: existing.info?.username };
  if (existing) await stopTenantBot(tid);

  if (!token) {
    console.log(`[bot] tenant ${tid}: no token configured`);
    return { changed: true, running: false };
  }
  try {
    const newBot = new Bot(token);
    attachHandlers(newBot, tid);
    const info = await newBot.api.getMe();
    await newBot.api.deleteWebhook({ drop_pending_updates: false });
    newBot.start({ drop_pending_updates: false, onStart: () => console.log(`[bot] tenant ${tid}: @${info.username} ready`) });
    runningBots.set(tid, { bot: newBot, info, token });
    return { changed: true, running: true, username: info.username };
  } catch (e) {
    console.error(`[bot] tenant ${tid} reload failed:`, e.message);
    return { changed: true, running: false, error: e.message };
  }
}

export function getBotStatus(tenantId) {
  const tid = tenantId || getDefaultTenantId();
  const entry = runningBots.get(tid);
  const cfg = readTenantConfig(tid);
  return {
    running: !!entry,
    username: entry?.info?.username || null,
    has_token: !!cfg.token,
    monitor_group_set: !!cfg.monitorGroupId,
    miniapp_url: cfg.miniappUrl,
    tenant_id: tid,
  };
}

export async function notifyApproved(tenantId, telegramId, name) {
  const entry = runningBots.get(tenantId);
  if (!entry || !telegramId) return;
  try {
    await entry.bot.api.sendMessage(telegramId, `🎉 Halo *${name}*, akun Anda *telah disetujui*!\n\nTap ⚡ Open WMS di bawah untuk mulai bekerja.`, {
      parse_mode: 'Markdown',
      reply_markup: openMiniAppKeyboard(tenantId),
    });
  } catch (e) { console.warn('[bot] notifyApproved failed:', e.message); }
}

export async function pushClockQRToMonitor(tenantId, qrSession, staff) {
  const entry = runningBots.get(tenantId);
  if (!entry) return;
  const chatId = resolveTargetChatId(tenantId, staff.department_id);
  if (!chatId) return;
  const qrText = `WMS-${qrSession.qr_token}`;
  const png = await QRCode.toBuffer(qrText, { width: 320, margin: 2 });
  const isStart = qrSession.action === 'clock_in';
  const label = isStart ? '📥 *START KERJA*' : '📤 *PULANG KERJA*';
  const dept = staff.department ? ` — ${staff.department}` : '';
  const mention = buildHeadMention(staff.department_id);
  const caption = `${mention}${label}\n👤 *${staff.name}*${dept}\n⏰ Berlaku 5 menit · sekali pakai`;
  try {
    await entry.bot.api.sendPhoto(chatId, new InputFile(png, `clock-${qrSession.id}.png`), { caption, parse_mode: 'Markdown' });
  } catch (e) { console.warn('[bot] pushClockQRToMonitor failed:', e.message); }
}

export async function pushBreakQRToMonitor(tenantId, breakLog, staff) {
  const entry = runningBots.get(tenantId);
  if (!entry) return;
  const chatId = resolveTargetChatId(tenantId, staff.department_id);
  if (!chatId) return;
  const me = entry.info || (await entry.bot.api.getMe());
  const deepLink = `https://t.me/${me.username}?start=qr_${breakLog.id}_${breakLog.qr_token}`;
  const png = await QRCode.toBuffer(deepLink, { width: 320, margin: 2 });
  const breakLabel = { smoke: '🚬 Smoke', toilet: '🚻 Toilet', outside: '🏪 Go Out' }[breakLog.type] || breakLog.type;
  const mention = buildHeadMention(staff.department_id);
  const caption = `${mention}${breakLabel}\n👤 *${staff.name}* — ${staff.department || '-'}\n⏰ Expires in 5 min\n\nScan QR ini untuk Back-to-Work.`;
  try {
    await entry.bot.api.sendPhoto(chatId, new InputFile(png, `qr-${breakLog.id}.png`), { caption, parse_mode: 'Markdown' });
  } catch (e) { console.warn('[bot] pushBreakQRToMonitor failed:', e.message); }
}

function getDeptInfo(deptId) {
  if (!deptId) return null;
  return db.prepare('SELECT id, name, head_telegram_id, head_username, monitor_group_chat_id FROM departments WHERE id = ?').get(deptId);
}

// Resolve target chat: dept's own group → tenant default group
function resolveTargetChatId(tenantId, deptId) {
  const dept = getDeptInfo(deptId);
  if (dept?.monitor_group_chat_id) return dept.monitor_group_chat_id;
  return readTenantConfig(tenantId).monitorGroupId;
}

// Build mention prefix tag head dept (deep link mention selalu nge-ping walau user belum kasih username)
function buildHeadMention(deptId) {
  const dept = getDeptInfo(deptId);
  if (!dept) return '';
  if (dept.head_telegram_id) {
    const name = dept.head_username || dept.name + ' Head';
    return `[${name}](tg://user?id=${dept.head_telegram_id}) `;
  }
  if (dept.head_username) return `@${dept.head_username} `;
  return '';
}

async function notifyMonitor(tenantId, text, deptId = null, opts = {}) {
  const entry = runningBots.get(tenantId);
  if (!entry) return;
  const chatId = resolveTargetChatId(tenantId, deptId);
  if (!chatId) return;
  const mention = buildHeadMention(deptId);
  try {
    await entry.bot.api.sendMessage(chatId, mention + text, { parse_mode: 'Markdown', ...opts });
  } catch (e) { console.warn('[bot] notifyMonitor failed:', e.message); }
}

export async function notifyLate(tenantId, staff, lateMin, shift) {
  const muted = (getTenantSetting(tenantId, 'notification_prefs', {}) || {}).muted_types || [];
  if (muted.includes('late')) return;
  const dept = staff.department ? ` · ${staff.department}` : '';
  await notifyMonitor(tenantId, `⚠️ *TELAT* — ${staff.name}${dept}\n⏱ ${lateMin} menit · shift _${shift}_`, staff.department_id);
}

export async function notifyIpViolation(tenantId, staff, action, ip) {
  const muted = (getTenantSetting(tenantId, 'notification_prefs', {}) || {}).muted_types || [];
  if (muted.includes('outside_ip_attempt')) return;
  const dept = staff.department ? ` · ${staff.department}` : '';
  const actions = { clock_in: 'START (Clock In)', clock_out: 'END (Clock Out)', break_start: 'Mulai Break', break_end: 'Back to Work' };
  const actionLabel = actions[action] || action;
  await notifyMonitor(
    tenantId,
    `🚨 *IP VIOLATION* — ${staff.name}${dept}\n` +
    `Mencoba *${actionLabel}* dari IP di luar kantor\n` +
    `IP: \`${ip}\``,
    staff.department_id
  );
}

export async function notifySwapRequest(tenantId, requester, partner, targetDate, partnerDate, currentShift, reason, swapId) {
  const muted = (getTenantSetting(tenantId, 'notification_prefs', {}) || {}).muted_types || [];
  if (muted.includes('shift_swap')) return;
  const entry = runningBots.get(tenantId);
  if (!entry) return;
  const chatId = resolveTargetChatId(tenantId, requester.department_id);
  if (!chatId) return;
  const mention = buildHeadMention(requester.department_id);
  const dept = requester.department ? ` · ${requester.department}` : '';
  let text;
  if (partner) {
    text = `${mention}🔄 *SWAP REQUEST (Trade)*\n\n` +
      `👤 ${requester.name}${dept}\n📅 ${targetDate} _(${currentShift})_\n` +
      `        ↕️\n` +
      `👤 ${partner.name}\n📅 ${partnerDate || targetDate}` +
      (reason ? `\n\n💬 ${reason}` : '');
  } else {
    text = `${mention}🔄 *REQUEST OFF*\n\n` +
      `👤 ${requester.name}${dept}\n📅 ${targetDate} _(${currentShift})_` +
      (reason ? `\n\n💬 ${reason}` : '');
  }
  const kb = new InlineKeyboard()
    .text('✅ Approve', `swap_approve_${swapId}`)
    .text('❌ Reject', `swap_reject_${swapId}`);
  try {
    await entry.bot.api.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb });
  } catch (e) { console.warn('[bot] notifySwapRequest failed:', e.message); }
}

export async function notifyOvertime(tenantId, staff, breakType, durationMin, limitMin) {
  const muted = (getTenantSetting(tenantId, 'notification_prefs', {}) || {}).muted_types || [];
  if (muted.includes('break_overtime')) return;
  const labels = { smoke: '🚬 Smoke', toilet: '🚻 Toilet', outside: '🏪 Go Out' };
  const overMin = Math.max(0, durationMin - limitMin);
  const dept = staff.department ? ` · ${staff.department}` : '';
  await notifyMonitor(
    tenantId,
    `⏰ *OVERTIME BREAK* — ${staff.name}${dept}\n` +
    `${labels[breakType] || breakType}: *${durationMin}m* / limit ${limitMin}m\n` +
    `Lewat: *+${overMin} menit*`,
    staff.department_id
  );
}

// Verify Telegram Mini App initData against ALL running tenant bots
// Returns { user, tenantId } or null
export function verifyInitData(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');

  for (const [tenantId, entry] of runningBots.entries()) {
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(entry.token).digest();
    const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (computed === hash) {
      const userJson = params.get('user');
      if (!userJson) return null;
      try { return { user: JSON.parse(userJson), tenantId }; } catch { return null; }
    }
  }
  return null;
}

// Start bots for ALL tenants that have bot_token configured
export async function startBot() {
  const tenants = db.prepare('SELECT id FROM tenants').all();
  for (const t of tenants) {
    await reloadBot(t.id);
  }
}

export function listRunningBots() {
  const out = [];
  for (const [tid, entry] of runningBots.entries()) out.push({ tenant_id: tid, username: entry.info?.username });
  return out;
}
