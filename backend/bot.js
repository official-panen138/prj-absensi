import { Bot, InlineKeyboard, InputFile, session } from 'grammy';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { db, getTenantSetting, getDefaultTenantId } from './db.js';
import { emitLiveUpdate } from './events.js';
import { renderSickPair, renderMoveOffPair, renderTradePair, renderSnapshot, renderSnapshotMulti, renderLeavePair } from './scheduleSnapshot.js';
import { applySwapApproval, applyLeaveApproval } from './approvals.js';

// Departments di-fetch dynamic dari DB per tenant — tidak hardcode lagi.
function getTenantDepartments(tenantId) {
  return db.prepare('SELECT id, name FROM departments WHERE tenant_id = ? ORDER BY name').all(tenantId);
}
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

function findStaffByName(tenantId, name) {
  return db.prepare('SELECT id, name, is_active, is_approved FROM staff WHERE tenant_id = ? AND LOWER(TRIM(name)) = LOWER(TRIM(?))').get(tenantId, name);
}

function findStaffByTelegramUsername(tenantId, username) {
  if (!username) return null;
  return db.prepare('SELECT id, name FROM staff WHERE tenant_id = ? AND LOWER(telegram_username) = LOWER(?)').get(tenantId, String(username).replace(/^@/, ''));
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
  bot.use(session({
    initial: () => ({ step: null, form: {}, pendingReject: null }),
    getSessionKey: (ctx) => {
      const chatId = ctx.chat?.id;
      const userId = ctx.from?.id;
      if (chatId == null || userId == null) return undefined;
      return `${chatId}_${userId}`; // per-(chat, user) supaya tiap admin di grup punya state sendiri
    },
  }));

  bot.command('start', async (ctx) => {
    const payload = ctx.match;
    if (payload && payload.startsWith('qr_')) return handleQrScan(ctx, tenantId, payload);

    const staff = findStaffByTelegramId(tenantId, ctx.from.id);
    if (staff && !staff.is_active) {
      return ctx.reply(`🚫 Halo ${staff.name}, akun Anda dinonaktifkan oleh admin. Hubungi admin kalau perlu reaktivasi — tidak bisa daftar ulang dengan akun Telegram yang sama.`);
    }
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

  bot.command('jadwal', async (ctx) => {
    const staff = findStaffByTelegramId(tenantId, ctx.from.id);
    if (!staff || !staff.is_approved) {
      return ctx.reply('⛔ Hanya staff terdaftar yang bisa lihat jadwal. Ketik /start dulu untuk daftar.');
    }
    if (!staff.department_id) {
      return ctx.reply('ℹ️ Anda belum di-assign ke department. Hubungi admin.');
    }
    // Bulan target: arg /jadwal YYYY-MM, default = bulan ini
    const arg = (ctx.match || '').trim();
    const today = new Date();
    let focusDate;
    if (/^\d{4}-\d{2}$/.test(arg)) {
      focusDate = `${arg}-01`;
    } else {
      focusDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
    }
    const monthLabel = focusDate.slice(0, 7);
    const deptName = staff.department || 'Schedule';
    // Cek status approval jadwal bulan ini
    const schedRow = db.prepare('SELECT status FROM schedules WHERE tenant_id = ? AND month = ?').get(tenantId, monthLabel);
    if (!schedRow) {
      return ctx.reply(
        `📭 *Jadwal ${monthLabel} belum dibuat*\n\nAdmin belum membuat jadwal untuk bulan ini. Tunggu pengumuman atau hubungi kepala department.`,
        { parse_mode: 'Markdown' }
      );
    }
    if (schedRow.status !== 'approved') {
      return ctx.reply(
        `⏳ *Jadwal ${monthLabel} masih DRAFT*\n\n` +
        `Jadwal sudah dibuat tapi *belum di-approve* oleh kepala department.\n` +
        `Mohon tunggu pengumuman resmi sebelum mengikuti jadwal ini.\n\n` +
        `_Status saat ini: ${schedRow.status}_`,
        { parse_mode: 'Markdown' }
      );
    }
    try {
      const png = await renderSnapshot(staff.department_id, staff.id, [today.toISOString().slice(0, 10)], `JADWAL TIM — ${deptName} (${monthLabel})`);
      if (!png) return ctx.reply(`ℹ️ Belum ada data jadwal harian untuk department ${deptName} di ${monthLabel}.`);
      await ctx.replyWithPhoto(new InputFile(png, 'jadwal.png'), {
        caption: `📅 *Jadwal ${deptName}* — ${monthLabel} ✅ _approved_\n\n_Tip: ketik /jadwal YYYY-MM untuk bulan lain (contoh: /jadwal 2026-05)_`,
        parse_mode: 'Markdown',
      });
    } catch (e) {
      console.warn('[bot] /jadwal:', e.message);
      await ctx.reply('❌ Gagal generate jadwal. Coba lagi.');
    }
  });

  bot.on('message:text', async (ctx) => {
    const txt = ctx.message.text.trim();
    const s = ctx.session;

    // Handle pending reject reason dari admin
    if (s.pendingReject) {
      if (!isAdmin(tenantId, ctx.from.id)) {
        s.pendingReject = null;
        return ctx.reply('⛔ Sesi tidak valid');
      }
      const pending = s.pendingReject;
      s.pendingReject = null;
      if (txt.toLowerCase() === 'batal') {
        return ctx.reply('🚫 Reject dibatalkan');
      }
      const reason = txt.toLowerCase() === 'skip' ? '' : txt;
      const by = ctx.from.first_name || ctx.from.username || ctx.from.id;

      if (pending.type === 'swap') {
        const sw = db.prepare('SELECT * FROM swap_requests WHERE id = ? AND tenant_id = ?').get(pending.id, tenantId);
        if (!sw) return ctx.reply('❌ Swap tidak ditemukan');
        if (sw.status !== 'pending') return ctx.reply('Sudah diproses sebelumnya');
        db.prepare('UPDATE swap_requests SET status = ?, reject_reason = ? WHERE id = ?').run('rejected', reason, pending.id);
        const requester = db.prepare('SELECT name, telegram_id FROM staff WHERE id = ?').get(sw.requester_id);
        if (requester?.telegram_id) {
          const msg = `❌ Request Anda untuk *${sw.target_date}* di-reject oleh admin.` + (reason ? `\n\n💬 Alasan: ${reason}` : '');
          try { await bot.api.sendMessage(requester.telegram_id, msg, { parse_mode: 'Markdown' }); } catch {}
        }
        const newText = pending.originalText + `\n\n━━━━━━━━━━━━\n❌ REJECTED oleh ${by}` + (reason ? `\n💬 Alasan: ${reason}` : '');
        try { await bot.api.editMessageText(pending.originalChatId, pending.originalMessageId, newText, { reply_markup: { inline_keyboard: [] } }); } catch {}
        return ctx.reply(`✅ Swap reject diproses${reason ? ' dengan alasan' : ''}.`);
      }

      if (pending.type === 'leave') {
        const lr = db.prepare('SELECT * FROM leave_requests WHERE id = ? AND tenant_id = ?').get(pending.id, tenantId);
        if (!lr) return ctx.reply('❌ Leave request tidak ditemukan');
        if (lr.status !== 'pending') return ctx.reply('Sudah diproses sebelumnya');
        db.prepare("UPDATE leave_requests SET status = 'rejected', reject_reason = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ?").run(reason, pending.id);
        const requester = db.prepare('SELECT name, telegram_id FROM staff WHERE id = ?').get(lr.staff_id);
        if (requester?.telegram_id) {
          const msg = `❌ Pengajuan *cuti* Anda (${lr.start_date} → ${lr.end_date}, ${lr.days} hari) di-reject oleh admin.` + (reason ? `\n\n💬 Alasan: ${reason}` : '');
          try { await bot.api.sendMessage(requester.telegram_id, msg, { parse_mode: 'Markdown' }); } catch {}
        }
        const newText = pending.originalText + `\n\n━━━━━━━━━━━━\n❌ REJECTED oleh ${by}` + (reason ? `\n💬 Alasan: ${reason}` : '');
        try { await bot.api.editMessageText(pending.originalChatId, pending.originalMessageId, newText, { reply_markup: { inline_keyboard: [] } }); } catch {}
        emitLiveUpdate(tenantId, 'leave_rejected', { leave_id: pending.id });
        return ctx.reply(`✅ Leave reject diproses${reason ? ' dengan alasan' : ''}.`);
      }

      if (pending.type === 'registration') {
        const staff = db.prepare('SELECT * FROM staff WHERE id = ? AND tenant_id = ?').get(pending.id, tenantId);
        if (!staff) return ctx.reply('❌ Staff tidak ditemukan');
        db.prepare('UPDATE staff SET is_active = 0 WHERE id = ?').run(pending.id);
        if (staff.telegram_id) {
          const msg = `❌ Maaf ${staff.name}, registrasi Anda *ditolak* oleh admin.` + (reason ? `\n\n💬 Alasan: ${reason}` : '\n\nHubungi admin untuk info lebih lanjut.');
          try { await bot.api.sendMessage(staff.telegram_id, msg, { parse_mode: 'Markdown' }); } catch {}
        }
        const newText = pending.originalText + `\n\n━━━━━━━━━━━━\n❌ REJECTED oleh ${by}` + (reason ? `\n💬 Alasan: ${reason}` : '');
        try { await bot.api.editMessageText(pending.originalChatId, pending.originalMessageId, newText, { reply_markup: { inline_keyboard: [] } }); } catch {}
        return ctx.reply(`✅ Registration reject diproses${reason ? ' dengan alasan' : ''}.`);
      }
    }

    const existing = findStaffByTelegramId(tenantId, ctx.from.id);
    if (existing && !existing.is_active) {
      // Block lanjut ngetik kalau akun dinonaktifkan
      ctx.session = { step: null, form: {} };
      return ctx.reply(`🚫 Akun Anda dinonaktifkan oleh admin. Tidak bisa daftar ulang. Hubungi admin.`);
    }
    if (existing && existing.is_approved && !s.step) {
      return ctx.reply('Tap below to open WMS.', { reply_markup: openMiniAppKeyboard(tenantId) });
    }
    if (existing && !existing.is_approved && !s.step) {
      return ctx.reply(`⏳ Akun Anda menunggu persetujuan admin. Mohon tunggu — tidak perlu daftar ulang.`);
    }

    if (s.step === 'pin') {
      const expected = getRegistrationPin(tenantId);
      if (txt !== expected) return ctx.reply('❌ PIN salah. Coba lagi atau hubungi admin.');
      s.step = 'name';
      return ctx.reply('✅ PIN benar.\n\nMasukkan *nama lengkap* Anda:', { parse_mode: 'Markdown' });
    }

    if (s.step === 'name') {
      if (txt.length < 2) return ctx.reply('Nama terlalu pendek. Coba lagi.');
      const dupName = findStaffByName(tenantId, txt);
      if (dupName) {
        return ctx.reply(`⚠ Nama *${txt}* sudah terdaftar di sistem (status: ${dupName.is_active ? (dupName.is_approved ? 'aktif' : 'menunggu approval') : 'dinonaktifkan'}). Pakai nama lengkap yang berbeda atau hubungi admin.`, { parse_mode: 'Markdown' });
      }
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
      const depts = getTenantDepartments(tenantId);
      if (!depts.length) {
        s.step = null; s.form = {};
        return ctx.reply('⚠ Belum ada department di tenant ini. Hubungi admin untuk tambah department dulu.');
      }
      // Simpan opsi ke session supaya validasi pakai snapshot yang sama (race-safe)
      s.form._dept_options = depts.map((d) => d.name);
      const list = depts.map((d, i) => `${i + 1} ${d.name}`).join('\n');
      return ctx.reply(`🏢 *Pilih department:*\n${list}\n\nKetik nomornya:`, { parse_mode: 'Markdown' });
    }

    if (s.step === 'department') {
      const opts = Array.isArray(s.form?._dept_options) ? s.form._dept_options : [];
      const idx = parseInt(txt) - 1;
      if (isNaN(idx) || !opts[idx]) return ctx.reply(`Pilihan tidak valid. Ketik 1-${opts.length}.`);
      s.form.department = opts[idx];
      delete s.form._dept_options;
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

      // Anti-duplikat — final guard sebelum INSERT
      const dupTg = findStaffByTelegramId(tenantId, ctx.from.id);
      if (dupTg) {
        ctx.session = { step: null, form: {} };
        return ctx.reply(`⚠ Akun Telegram Anda sudah terdaftar sebagai *${dupTg.name}* (status: ${dupTg.is_active ? (dupTg.is_approved ? 'aktif' : 'menunggu approval') : 'dinonaktifkan'}). Tidak bisa daftar 2x.`, { parse_mode: 'Markdown' });
      }
      const dupName = findStaffByName(tenantId, s.form.name);
      if (dupName) {
        ctx.session = { step: null, form: {} };
        return ctx.reply(`⚠ Nama *${s.form.name}* sudah terdaftar oleh staff lain. Hubungi admin.`, { parse_mode: 'Markdown' });
      }
      if (ctx.from.username) {
        const dupUser = findStaffByTelegramUsername(tenantId, ctx.from.username);
        if (dupUser) {
          ctx.session = { step: null, form: {} };
          return ctx.reply(`⚠ Username Telegram @${ctx.from.username} sudah terdaftar sebagai *${dupUser.name}*. Hubungi admin.`, { parse_mode: 'Markdown' });
        }
      }

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
    const orig = ctx.callbackQuery.message.text || '';
    const newText = orig + `\n\n━━━━━━━━━━━━\n✅ APPROVED oleh ${by}`;
    try { await ctx.editMessageText(newText, { reply_markup: { inline_keyboard: [] } }); } catch {}
    await ctx.answerCallbackQuery({ text: '✅ Approved!' });
  });

  bot.callbackQuery(/^swap_approve_(\d+)$/, async (ctx) => {
    const swapId = parseInt(ctx.match[1]);
    if (!isAdmin(tenantId, ctx.from.id)) return ctx.answerCallbackQuery({ text: '⛔ Unauthorized', show_alert: true });
    const sw = db.prepare('SELECT * FROM swap_requests WHERE id = ? AND tenant_id = ?').get(swapId, tenantId);
    if (!sw) return ctx.answerCallbackQuery({ text: 'Swap tidak ditemukan', show_alert: true });
    if (sw.status !== 'pending') return ctx.answerCallbackQuery({ text: 'Sudah diproses sebelumnya', show_alert: true });
    const type = sw.swap_type || (sw.target_staff_id ? 'trade' : 'sick');

    const apply = applySwapApproval(sw);
    if (apply.error) return ctx.answerCallbackQuery({ text: apply.error, show_alert: true });

    db.prepare('UPDATE swap_requests SET status = ? WHERE id = ?').run('approved', swapId);
    emitLiveUpdate(tenantId, 'swap_approved', { swap_id: swapId });
    const requester = db.prepare('SELECT name, telegram_id FROM staff WHERE id = ?').get(sw.requester_id);
    if (requester?.telegram_id) {
      const typeLabel = { trade: 'Trade Shift', move_off: 'Tukar Off Day', sick: 'Izin Sakit' }[type] || 'Swap';
      try { await bot.api.sendMessage(requester.telegram_id, `✅ *${typeLabel}* untuk *${sw.target_date}* di-approve!`, { parse_mode: 'Markdown', reply_markup: openMiniAppKeyboard(tenantId) }); } catch {}
    }
    const by = ctx.from.first_name || ctx.from.username || ctx.from.id;
    const orig = ctx.callbackQuery.message.text || '';
    const newText = orig + `\n\n━━━━━━━━━━━━\n✅ APPROVED oleh ${by}`;
    try { await ctx.editMessageText(newText, { reply_markup: { inline_keyboard: [] } }); } catch {}
    await ctx.answerCallbackQuery({ text: '✅ Approved!' });
    pushSwapResultSnapshot(tenantId, sw).catch(() => {});
  });

  bot.callbackQuery(/^swap_reject_(\d+)$/, async (ctx) => {
    const swapId = parseInt(ctx.match[1]);
    if (!isAdmin(tenantId, ctx.from.id)) return ctx.answerCallbackQuery({ text: '⛔ Unauthorized', show_alert: true });
    const sw = db.prepare('SELECT * FROM swap_requests WHERE id = ? AND tenant_id = ?').get(swapId, tenantId);
    if (!sw) return ctx.answerCallbackQuery({ text: 'Swap tidak ditemukan', show_alert: true });
    if (sw.status !== 'pending') return ctx.answerCallbackQuery({ text: 'Sudah diproses', show_alert: true });
    // Set pending reject state — admin akan ketik alasan di chat ini
    ctx.session.pendingReject = {
      type: 'swap',
      id: swapId,
      originalText: ctx.callbackQuery.message.text || '',
      originalChatId: ctx.callbackQuery.message.chat.id,
      originalMessageId: ctx.callbackQuery.message.message_id,
    };
    await ctx.answerCallbackQuery({ text: 'Ketik alasan reject di chat ini' });
    try {
      await ctx.reply(`💬 Ketik *alasan reject* untuk swap request ini:\n_(ketik "skip" kalau tanpa alasan — batal: ketik "batal")_`, {
        parse_mode: 'Markdown',
        reply_markup: { force_reply: true, selective: true },
      });
    } catch {}
  });

  bot.callbackQuery(/^leave_approve_(\d+)$/, async (ctx) => {
    const leaveId = parseInt(ctx.match[1]);
    if (!isAdmin(tenantId, ctx.from.id)) return ctx.answerCallbackQuery({ text: '⛔ Unauthorized', show_alert: true });
    const lr = db.prepare('SELECT * FROM leave_requests WHERE id = ? AND tenant_id = ?').get(leaveId, tenantId);
    if (!lr) return ctx.answerCallbackQuery({ text: 'Leave request tidak ditemukan', show_alert: true });
    if (lr.status !== 'pending') return ctx.answerCallbackQuery({ text: 'Sudah diproses sebelumnya', show_alert: true });
    const apply = applyLeaveApproval(lr);
    if (apply.error) return ctx.answerCallbackQuery({ text: apply.error, show_alert: true });
    emitLiveUpdate(tenantId, 'leave_approved', { leave_id: leaveId });
    const requester = db.prepare('SELECT name, telegram_id FROM staff WHERE id = ?').get(lr.staff_id);
    if (requester?.telegram_id) {
      try { await bot.api.sendMessage(requester.telegram_id, `✅ Pengajuan *cuti* Anda (${lr.start_date} → ${lr.end_date}, ${lr.days} hari) di-approve! Selamat beristirahat 🙏`, { parse_mode: 'Markdown', reply_markup: openMiniAppKeyboard(tenantId) }); } catch {}
    }
    const by = ctx.from.first_name || ctx.from.username || ctx.from.id;
    const orig = ctx.callbackQuery.message.text || '';
    const newText = orig + `\n\n━━━━━━━━━━━━\n✅ APPROVED oleh ${by}`;
    try { await ctx.editMessageText(newText, { reply_markup: { inline_keyboard: [] } }); } catch {}
    await ctx.answerCallbackQuery({ text: '✅ Approved!' });
    pushLeaveResultSnapshot(tenantId, lr).catch(() => {});
  });

  bot.callbackQuery(/^leave_reject_(\d+)$/, async (ctx) => {
    const leaveId = parseInt(ctx.match[1]);
    if (!isAdmin(tenantId, ctx.from.id)) return ctx.answerCallbackQuery({ text: '⛔ Unauthorized', show_alert: true });
    const lr = db.prepare('SELECT * FROM leave_requests WHERE id = ? AND tenant_id = ?').get(leaveId, tenantId);
    if (!lr) return ctx.answerCallbackQuery({ text: 'Leave tidak ditemukan', show_alert: true });
    if (lr.status !== 'pending') return ctx.answerCallbackQuery({ text: 'Sudah diproses', show_alert: true });
    ctx.session.pendingReject = {
      type: 'leave',
      id: leaveId,
      originalText: ctx.callbackQuery.message.text || '',
      originalChatId: ctx.callbackQuery.message.chat.id,
      originalMessageId: ctx.callbackQuery.message.message_id,
    };
    await ctx.answerCallbackQuery({ text: 'Ketik alasan reject di chat ini' });
    try {
      await ctx.reply(`💬 Ketik *alasan reject* untuk pengajuan cuti ini:\n_(ketik "skip" kalau tanpa alasan — batal: ketik "batal")_`, {
        parse_mode: 'Markdown',
        reply_markup: { force_reply: true, selective: true },
      });
    } catch {}
  });

  bot.callbackQuery(/^reject_(\d+)$/, async (ctx) => {
    const staffId = parseInt(ctx.match[1]);
    if (!isAdmin(tenantId, ctx.from.id)) return ctx.answerCallbackQuery({ text: '⛔ Unauthorized', show_alert: true });
    const staff = db.prepare('SELECT * FROM staff WHERE id = ? AND tenant_id = ?').get(staffId, tenantId);
    if (!staff) return ctx.answerCallbackQuery({ text: 'Staff tidak ditemukan', show_alert: true });
    // Set pending reject state — admin akan ketik alasan di chat ini
    ctx.session.pendingReject = {
      type: 'registration',
      id: staffId,
      originalText: ctx.callbackQuery.message.text || '',
      originalChatId: ctx.callbackQuery.message.chat.id,
      originalMessageId: ctx.callbackQuery.message.message_id,
    };
    await ctx.answerCallbackQuery({ text: 'Ketik alasan reject di chat ini' });
    try {
      await ctx.reply(`💬 Ketik *alasan reject* untuk pendaftaran *${staff.name}*:\n_(ketik "skip" kalau tanpa alasan — batal: ketik "batal")_`, {
        parse_mode: 'Markdown',
        reply_markup: { force_reply: true, selective: true },
      });
    } catch {}
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
  const chatId = resolveQrChatId(tenantId, staff.department_id);
  if (!chatId) return;
  const qrText = `WMS-${qrSession.qr_token}`;
  const png = await QRCode.toBuffer(qrText, { width: 320, margin: 2 });
  const isStart = qrSession.action === 'clock_in';
  const label = isStart ? '📥 *START KERJA*' : '📤 *PULANG KERJA*';
  const dept = staff.department ? ` — ${staff.department}` : '';
  const caption = `${label}\n👤 *${staff.name}*${dept}\n⏰ Berlaku 5 menit · sekali pakai`;
  try {
    await entry.bot.api.sendPhoto(chatId, new InputFile(png, `clock-${qrSession.id}.png`), { caption, parse_mode: 'Markdown' });
  } catch (e) { console.warn('[bot] pushClockQRToMonitor failed:', e.message); }
}

export async function pushBreakQRToMonitor(tenantId, breakLog, staff) {
  const entry = runningBots.get(tenantId);
  if (!entry) return;
  const chatId = resolveQrChatId(tenantId, staff.department_id);
  if (!chatId) return;
  const me = entry.info || (await entry.bot.api.getMe());
  const deepLink = `https://t.me/${me.username}?start=qr_${breakLog.id}_${breakLog.qr_token}`;
  const png = await QRCode.toBuffer(deepLink, { width: 320, margin: 2 });
  const breakLabel = { smoke: '🚬 Smoke', toilet: '🚻 Toilet', outside: '🏪 Go Out' }[breakLog.type] || breakLog.type;
  const caption = `${breakLabel}\n👤 *${staff.name}* — ${staff.department || '-'}\n⏰ Expires in 5 min\n\nScan QR ini untuk Back-to-Work.`;
  try {
    await entry.bot.api.sendPhoto(chatId, new InputFile(png, `qr-${breakLog.id}.png`), { caption, parse_mode: 'Markdown' });
  } catch (e) { console.warn('[bot] pushBreakQRToMonitor failed:', e.message); }
}

function getDeptInfo(deptId) {
  if (!deptId) return null;
  return db.prepare('SELECT id, name, head_telegram_id, head_username, assistant_telegram_id, assistant_username, monitor_group_chat_id FROM departments WHERE id = ?').get(deptId);
}

// Resolve target chat: dept's own group → tenant default group
function resolveTargetChatId(tenantId, deptId) {
  const dept = getDeptInfo(deptId);
  if (dept?.monitor_group_chat_id) return dept.monitor_group_chat_id;
  return readTenantConfig(tenantId).monitorGroupId;
}

// Resolve chat khusus untuk QR absensi (dipisah dari grup pelanggaran).
// Priority: tenant-setting qr_monitor_group_chat_id → dept group → tenant default
function resolveQrChatId(tenantId, deptId) {
  const qrGroup = getTenantSetting(tenantId, 'qr_monitor_group_chat_id', null);
  if (qrGroup) {
    const v = String(qrGroup).trim();
    if (v) {
      console.log(`[bot] QR routed to dedicated group ${v} (tenant ${tenantId})`);
      return v;
    }
  }
  const fallback = resolveTargetChatId(tenantId, deptId);
  console.log(`[bot] QR fallback chat=${fallback} (tenant ${tenantId}, dept ${deptId}) — qr_monitor_group_chat_id not set`);
  return fallback;
}

// Build mention prefix tag head + asisten dept (deep link mention selalu nge-ping walau user belum kasih username)
function buildHeadMention(deptId) {
  const dept = getDeptInfo(deptId);
  if (!dept) return '';
  const mentions = [];
  if (dept.head_telegram_id) {
    const name = dept.head_username || dept.name + ' Head';
    mentions.push(`[${name}](tg://user?id=${dept.head_telegram_id})`);
  } else if (dept.head_username) {
    mentions.push(`@${dept.head_username}`);
  }
  if (dept.assistant_telegram_id) {
    const name = dept.assistant_username || dept.name + ' Assistant';
    mentions.push(`[${name}](tg://user?id=${dept.assistant_telegram_id})`);
  } else if (dept.assistant_username) {
    mentions.push(`@${dept.assistant_username}`);
  }
  return mentions.length ? mentions.join(' ') + ' ' : '';
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

export async function notifyLate(tenantId, staff, lateMin, shift, withinGrace = false) {
  const muted = (getTenantSetting(tenantId, 'notification_prefs', {}) || {}).muted_types || [];
  if (muted.includes('late')) return;
  const dept = staff.department ? ` · ${staff.department}` : '';
  const prefix = withinGrace ? '⚠️ *Telat (dalam grace)*' : '⚠️ *TELAT*';
  const note = withinGrace ? `\n_dalam toleransi — tidak kurangi skor_` : '';
  await notifyMonitor(
    tenantId,
    `${prefix} — ${staff.name}${dept}\n⏱ ${lateMin} menit · shift _${shift}_${note}`,
    staff.department_id,
  );
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

// Build snapshot jadwal dept untuk minggu yang berisi focusDate
// markedDates di-tandai * di baris requester. Return string code-block siap dikirim.
function formatScheduleSnapshot(deptId, requesterId, markedDates = []) {
  const dept = deptId ? db.prepare('SELECT name FROM departments WHERE id = ?').get(deptId) : null;
  const focusDate = markedDates[0];
  if (!focusDate) return '';
  // Cari Senin minggu yang berisi focusDate
  const focus = new Date(focusDate + 'T00:00:00');
  const dow = focus.getDay(); // 0=Sun..6=Sat
  const offsetToMonday = (dow + 6) % 7;
  const monday = new Date(focus);
  monday.setDate(focus.getDate() - offsetToMonday);
  const dates = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d.toISOString().slice(0, 10);
  });
  const dayLabels = ['Sn', 'Sl', 'Rb', 'Km', 'Jm', 'Sb', 'Mg'];

  // Ambil staff aktif dept
  const staff = deptId
    ? db.prepare('SELECT id, name FROM staff WHERE department_id = ? AND is_active = 1 AND is_approved = 1 ORDER BY name').all(deptId)
    : [{ id: requesterId, name: db.prepare('SELECT name FROM staff WHERE id = ?').get(requesterId)?.name || 'Staff' }];
  if (!staff.length) return '';

  // Ambil schedule untuk semua staff di range tanggal
  const sIds = staff.map((s) => s.id);
  const sPlace = sIds.map(() => '?').join(',');
  const dPlace = dates.map(() => '?').join(',');
  const rows = db.prepare(`SELECT staff_id, date, status, shift FROM schedule_daily WHERE staff_id IN (${sPlace}) AND date IN (${dPlace})`)
    .all(...sIds, ...dates);
  const sched = {};
  rows.forEach((r) => { sched[`${r.staff_id}_${r.date}`] = r; });

  // Format
  const cellW = 4;
  const nameW = Math.min(14, Math.max(10, ...staff.map((s) => s.name.length)));
  const padR = (s, w) => String(s).slice(0, w).padEnd(w);
  const symbolFor = (sd) => {
    if (!sd) return '·';
    if (sd.status === 'work') return sd.shift === 'morning' ? 'M' : sd.shift === 'middle' ? 'D' : 'N';
    if (sd.status === 'off') return 'OFF';
    if (sd.status === 'sick') return 'SCK';
    if (sd.status === 'leave') return 'LV';
    return '?';
  };

  let txt = '```\n';
  if (dept) txt += `${dept.name} — week ${dates[0].slice(5)}\n`;
  txt += padR('', nameW) + ' ' + dayLabels.map((d) => padR(d, cellW)).join('') + '\n';
  txt += padR('', nameW) + ' ' + dates.map((d) => padR(d.slice(8, 10), cellW)).join('') + '\n';
  staff.forEach((s) => {
    const isReq = s.id === requesterId;
    const namePrefix = (isReq ? '▶ ' : '  ') + s.name;
    const cells = dates.map((d) => {
      let sym = symbolFor(sched[`${s.id}_${d}`]);
      if (markedDates.includes(d) && isReq) sym = sym + '*';
      return padR(sym, cellW);
    });
    txt += padR(namePrefix, nameW) + ' ' + cells.join('') + '\n';
  });
  txt += '```\n_M=Morning · D=Middle · N=Night · OFF · SCK=Sick · LV=Leave_\n_▶ = requester · \\* = tanggal terdampak_';
  return txt;
}

export async function notifySwapRequest(tenantId, requester, partner, targetDate, partnerDate, currentShift, reason, swapId, swapType) {
  const muted = (getTenantSetting(tenantId, 'notification_prefs', {}) || {}).muted_types || [];
  if (muted.includes('shift_swap')) return;
  const entry = runningBots.get(tenantId);
  if (!entry) return;
  const chatId = resolveTargetChatId(tenantId, requester.department_id);
  if (!chatId) return;
  const mention = buildHeadMention(requester.department_id);
  const dept = requester.department ? ` · ${requester.department}` : '';
  let text;
  if (swapType === 'trade') {
    text = `${mention}🔄 *SWAP REQUEST (Trade Shift)*\n\n` +
      `👤 ${requester.name}${dept}\n📅 ${targetDate} _(${currentShift})_\n` +
      `        ↕️\n` +
      `👤 ${partner?.name || '-'}\n📅 ${partnerDate || targetDate}` +
      (reason ? `\n\n💬 ${reason}` : '');
  } else if (swapType === 'move_off') {
    text = `${mention}🔁 *TUKAR OFF DAY*\n\n` +
      `👤 ${requester.name}${dept}\n` +
      `Off asli: 📅 *${targetDate}*\n` +
      `Pindah ke: 📅 *${partnerDate}*` +
      (reason ? `\n\n💬 ${reason}` : '');
  } else if (swapType === 'sick') {
    text = `${mention}🤒 *IZIN SAKIT*\n\n` +
      `👤 ${requester.name}${dept}\n📅 ${targetDate}` +
      (reason ? `\n\n💬 ${reason}` : '');
  } else {
    text = `${mention}🔄 *Swap Request*\n👤 ${requester.name}${dept}\n📅 ${targetDate}` + (reason ? `\n💬 ${reason}` : '');
  }
  const kb = new InlineKeyboard()
    .text('✅ Approve', `swap_approve_${swapId}`)
    .text('❌ Reject', `swap_reject_${swapId}`);
  // Render snapshot BEFORE dulu, baru kirim notif dengan tombol di bawahnya
  // (admin scroll ke bawah untuk lihat tombol — snapshot di atas sebagai konteks)
  const deptName = requester.department || 'Schedule';
  try {
    if (swapType === 'sick') {
      const pair = await renderSickPair(requester.department_id, requester.id, targetDate, deptName);
      if (pair?.before) await entry.bot.api.sendPhoto(chatId, new InputFile(pair.before, 'before.png'), { caption: '📋 *Jadwal saat ini* (kondisi sekarang)', parse_mode: 'Markdown' });
    } else if (swapType === 'move_off') {
      const pair = await renderMoveOffPair(requester.department_id, requester.id, targetDate, partnerDate, requester.current_shift, deptName);
      if (pair?.before) await entry.bot.api.sendPhoto(chatId, new InputFile(pair.before, 'before.png'), { caption: '📋 *Jadwal saat ini* (kondisi sekarang)', parse_mode: 'Markdown' });
      if (pair?.beforeWk2) await entry.bot.api.sendPhoto(chatId, new InputFile(pair.beforeWk2, 'before2.png'), { caption: '📋 *Jadwal saat ini* (bulan kedua)', parse_mode: 'Markdown' });
    } else if (swapType === 'trade' && partner) {
      const pair = await renderTradePair(requester.department_id, requester.id, partner.id, targetDate, partnerDate || targetDate, deptName);
      if (pair?.before) await entry.bot.api.sendPhoto(chatId, new InputFile(pair.before, 'before.png'), { caption: '📋 *Jadwal saat ini* (kondisi sekarang)', parse_mode: 'Markdown' });
    }
  } catch (e) { console.warn('[bot] render BEFORE snapshot:', e.message); }
  try {
    await entry.bot.api.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb });
  } catch (e) { console.warn('[bot] notifySwapRequest send notif failed:', e.message); }
}

export async function notifyLeaveRequest(tenantId, requester, payload) {
  const muted = (getTenantSetting(tenantId, 'notification_prefs', {}) || {}).muted_types || [];
  if (muted.includes('shift_swap')) return; // pakai prefs yg sama dengan swap
  const entry = runningBots.get(tenantId);
  if (!entry) return;
  const chatId = resolveTargetChatId(tenantId, requester.department_id);
  if (!chatId) return;
  const mention = buildHeadMention(requester.department_id);
  const dept = requester.department ? ` · ${requester.department}` : '';
  const { start_date, end_date, days, reason, period_key, leave_id } = payload;
  const deptName = requester.department || 'Schedule';
  // Render snapshot BEFORE — kepala dapat melihat jadwal seluruh dept saat menentukan approve/reject
  try {
    const pair = await renderLeavePair(requester.department_id, requester.id, start_date, end_date, deptName, days);
    if (pair?.before) {
      await entry.bot.api.sendPhoto(chatId, new InputFile(pair.before, 'leave-before.png'), {
        caption: `📋 *Jadwal saat ini* (${start_date.slice(0, 7)}) — kondisi sekarang sebelum cuti`,
        parse_mode: 'Markdown',
      });
    }
    if (pair?.beforeWk2) {
      await entry.bot.api.sendPhoto(chatId, new InputFile(pair.beforeWk2, 'leave-before2.png'), {
        caption: `📋 *Jadwal saat ini* (${end_date.slice(0, 7)}) — bulan kedua`,
        parse_mode: 'Markdown',
      });
    }
  } catch (e) { console.warn('[bot] render leave BEFORE snapshot:', e.message); }

  const text = `${mention}🏖️ *PENGAJUAN CUTI*\n\n` +
    `👤 ${requester.name}${dept}\n` +
    `📅 ${start_date} → ${end_date}\n` +
    `⏳ ${days} hari · period ${period_key}` +
    (reason ? `\n\n💬 ${reason}` : '');
  const kb = new InlineKeyboard()
    .text('✅ Approve', `leave_approve_${leave_id}`)
    .text('❌ Reject', `leave_reject_${leave_id}`);
  try {
    await entry.bot.api.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb });
  } catch (e) { console.warn('[bot] notifyLeaveRequest send notif failed:', e.message); }
}

// Dipanggil SETELAH leave di-approve. Render snapshot dari DB state sekarang.
export async function pushLeaveResultSnapshot(tenantId, lr) {
  const entry = runningBots.get(tenantId);
  if (!entry) return;
  const requester = db.prepare('SELECT * FROM staff WHERE id = ?').get(lr.staff_id);
  if (!requester) return;
  const chatId = resolveTargetChatId(tenantId, requester.department_id);
  if (!chatId) return;
  const deptName = requester.department || 'Schedule';
  const send = async (buf, caption) => {
    if (!buf) return;
    try { await entry.bot.api.sendPhoto(chatId, new InputFile(buf, 'leave-after.png'), { caption, parse_mode: 'Markdown' }); }
    catch (e) { console.warn('[bot] leave result snapshot send:', e.message); }
  };
  try {
    const m1 = lr.start_date.slice(0, 7);
    const m2 = lr.end_date.slice(0, 7);
    const datesMarked = [];
    const start = new Date(lr.start_date + 'T00:00:00').getTime();
    const end = new Date(lr.end_date + 'T00:00:00').getTime();
    for (let t = start; t <= end; t += 86400000) datesMarked.push(new Date(t).toISOString().slice(0, 10));

    const img1 = await renderSnapshot(requester.department_id, requester.id, datesMarked, `AFTER APPROVE — Cuti ${lr.start_date}→${lr.end_date} (${m1}, ${deptName})`);
    await send(img1, `✅ *Setelah approve* — cuti ${lr.start_date} → ${lr.end_date} (${lr.days} hari)`);
    if (m1 !== m2) {
      const img2 = await renderSnapshot(requester.department_id, requester.id, datesMarked, `AFTER APPROVE — Cuti (${m2}, ${deptName})`);
      await send(img2, `✅ *Setelah approve* — bulan kedua (${m2})`);
    }
  } catch (e) { console.warn('[bot] pushLeaveResultSnapshot:', e.message); }
}

// Dipanggil SETELAH swap di-approve. Render snapshot dari DB state sekarang
// (yang sudah ter-update) lalu kirim ke monitor group dengan caption "Setelah approve".
export async function pushSwapResultSnapshot(tenantId, sw) {
  const entry = runningBots.get(tenantId);
  if (!entry) return;
  const requester = db.prepare('SELECT * FROM staff WHERE id = ?').get(sw.requester_id);
  if (!requester) return;
  const chatId = resolveTargetChatId(tenantId, requester.department_id);
  if (!chatId) return;
  const deptName = requester.department || 'Schedule';
  const type = sw.swap_type || (sw.target_staff_id ? 'trade' : 'sick');
  const send = async (buf, caption) => {
    if (!buf) return;
    try { await entry.bot.api.sendPhoto(chatId, new InputFile(buf, 'after.png'), { caption, parse_mode: 'Markdown' }); }
    catch (e) { console.warn('[bot] result snapshot send:', e.message); }
  };
  try {
    if (type === 'sick') {
      const img = await renderSnapshot(requester.department_id, requester.id, [sw.target_date], `AFTER APPROVE — ${sw.target_date.slice(0, 7)} (${deptName})`);
      await send(img, `✅ *Setelah approve* — Sick on ${sw.target_date}`);
    } else if (type === 'move_off') {
      const m1 = sw.target_date.slice(0, 7);
      const m2 = (sw.partner_date || '').slice(0, 7);
      const img1 = await renderSnapshot(requester.department_id, requester.id, [sw.target_date, sw.partner_date].filter(Boolean), `AFTER APPROVE — ${m1} (${deptName})`);
      await send(img1, `✅ *Setelah approve* — off pindah ${sw.target_date} → ${sw.partner_date}`);
      if (m2 && m1 !== m2) {
        const img2 = await renderSnapshot(requester.department_id, requester.id, [sw.target_date, sw.partner_date], `AFTER APPROVE — ${m2} (${deptName})`);
        await send(img2, `✅ *Setelah approve* — bulan kedua (${m2})`);
      }
    } else if (type === 'trade') {
      const partnerStaff = db.prepare('SELECT id FROM staff WHERE id = ?').get(sw.target_staff_id);
      if (partnerStaff) {
        const focusDate = sw.target_date <= (sw.partner_date || sw.target_date) ? sw.target_date : sw.partner_date;
        const markedMap = { [sw.requester_id]: [sw.target_date], [sw.target_staff_id]: [sw.partner_date || sw.target_date] };
        const img = await renderSnapshotMulti(requester.department_id, sw.requester_id, markedMap, `AFTER APPROVE — Trade ${sw.target_date} <-> ${sw.partner_date || sw.target_date} (${deptName})`, focusDate);
        await send(img, `✅ *Setelah approve* — shift swapped`);
      }
    }
  } catch (e) { console.warn('[bot] pushSwapResultSnapshot:', e.message); }
}

// Daily morning briefing — daftar staff off/sakit/cuti hari ini per department
function todayPPLocal() {
  return new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
}

export async function notifyDailyOffSummary(tenantId, dateStr = null) {
  const muted = (getTenantSetting(tenantId, 'notification_prefs', {}) || {}).muted_types || [];
  if (muted.includes('daily_summary')) return;
  const entry = runningBots.get(tenantId);
  if (!entry) return;
  const today = dateStr || todayPPLocal();
  const dow = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'][new Date(today + 'T00:00:00').getDay()];
  const depts = db.prepare('SELECT id, name, head_telegram_id, head_username, monitor_group_chat_id FROM departments WHERE tenant_id = ?').all(tenantId);
  for (const dept of depts) {
    const rows = db.prepare(`
      SELECT s.name, sd.status FROM schedule_daily sd
      JOIN staff s ON s.id = sd.staff_id
      WHERE sd.date = ? AND s.tenant_id = ? AND s.department_id = ? AND s.is_active = 1 AND s.is_approved = 1
        AND sd.status IN ('off','sick','leave')
      ORDER BY sd.status, s.name
    `).all(today, tenantId, dept.id);

    const chatId = resolveTargetChatId(tenantId, dept.id);
    if (!chatId) continue;
    const mention = buildHeadMention(dept.id);

    let body;
    if (rows.length === 0) {
      body = `${mention}🌅 *BRIEFING ${dow} ${today}*\n🏬 ${dept.name}\n\n✅ Tidak ada staff yang libur/sakit/cuti hari ini.\nFull team — semangat! 💪`;
    } else {
      const groups = { off: [], sick: [], leave: [] };
      for (const r of rows) groups[r.status].push(r.name);
      const parts = [];
      if (groups.off.length) parts.push(`🛌 *OFF (${groups.off.length})*\n${groups.off.map((n) => '• ' + n).join('\n')}`);
      if (groups.sick.length) parts.push(`🤒 *SAKIT (${groups.sick.length})*\n${groups.sick.map((n) => '• ' + n).join('\n')}`);
      if (groups.leave.length) parts.push(`🏖️ *CUTI (${groups.leave.length})*\n${groups.leave.map((n) => '• ' + n).join('\n')}`);
      body = `${mention}🌅 *BRIEFING ${dow} ${today}*\n🏬 ${dept.name}\n\n${parts.join('\n\n')}\n\n_Total tidak hadir: ${rows.length} orang_`;
    }
    try {
      await entry.bot.api.sendMessage(chatId, body, { parse_mode: 'Markdown' });
    } catch (e) { console.warn('[bot] notifyDailyOffSummary failed:', e.message); }
  }
}

// Auto-close stale shifts: aggregate notif per dept group
export async function notifyAutoCloseSummary(tenantId, closedRows) {
  if (!Array.isArray(closedRows) || !closedRows.length) return;
  const muted = (getTenantSetting(tenantId, 'notification_prefs', {}) || {}).muted_types || [];
  if (muted.includes('auto_close')) return;
  // Group by department_id supaya tiap dept dapat list staff dept-nya saja
  const byDept = new Map();
  for (const r of closedRows) {
    const k = r.department_id || 'no_dept';
    if (!byDept.has(k)) byDept.set(k, []);
    byDept.get(k).push(r);
  }
  for (const [deptId, items] of byDept) {
    const lines = items.map((r) => `• ${r.name} — ${r.date} (${r.shift})`).join('\n');
    await notifyMonitor(
      tenantId,
      `🤖 *AUTO-CLOSE SHIFT BASI* — ${items.length} staff lupa clock-out:\n\n${lines}\n\n_Sistem auto-close di shift_end. Cek attendance kalau perlu adjust._`,
      deptId === 'no_dept' ? null : deptId,
    );
  }
}

// Admin override: force clock-in / force clock-out — kasih tahu dept group
export async function notifyAdminOverride(tenantId, staff, action, by, reason, extra = {}) {
  const muted = (getTenantSetting(tenantId, 'notification_prefs', {}) || {}).muted_types || [];
  if (muted.includes('admin_override')) return;
  const dept = staff.department ? ` · ${staff.department}` : '';
  const labels = {
    force_clock_in: '🔓 *ADMIN OVERRIDE — Force Clock-In*',
    force_clock_out: '🔓 *ADMIN OVERRIDE — Force Clock-Out*',
  };
  const label = labels[action] || `🔓 *ADMIN OVERRIDE — ${action}*`;
  const reasonLine = reason ? `\n💬 ${reason}` : '';
  const extras = [];
  if (extra.late_minutes != null) extras.push(`⏱ Telat: ${extra.late_minutes} menit`);
  if (extra.shift) extras.push(`Shift: _${extra.shift}_`);
  const extraLine = extras.length ? `\n${extras.join(' · ')}` : '';
  await notifyMonitor(
    tenantId,
    `${label}\n👤 ${staff.name}${dept}\n👮 oleh: ${by}${extraLine}${reasonLine}`,
    staff.department_id,
  );
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
