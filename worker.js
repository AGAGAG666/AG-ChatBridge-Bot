// ======== 常量定义 ========
const CONSTANTS = {
    MAX_RECENT_USERS: 50,
    PAGE_SIZE: 5,
    DEFAULT_DURATION_MIN: 10,
    VERIFY_TOKEN_EXPIRE_SEC: 300,
    BROADCAST_EXPIRE_SEC: 3600,
    REPLY_MAP_EXPIRE_SEC: 3600,
    NOTIFY_COOLDOWN_SEC: 600,
    MATH_VERIFY_EXPIRE_SEC: 300
};

// ======== 工具函数 ========
// 全局验证缓存（跨请求共享，避免 KV 最终一致性延迟）
const verifiedCache = new Map();

const createApi = (botToken) => (method, body) =>
    fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }).then(r => r.json());

const endOfDayTtl = () => {
    const now = new Date();
    const eod = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
    return Math.floor((eod - now) / 1000);
};

async function getState(kv, owner, type) {
    const [idKey, expKey] = type === 'ban' ? ['ban', 'ban_expire'] : ['reply_target', 'reply_target_expire'];
    const id = await kv.get(`${idKey}:${owner}`);
    if (!id) return null;
    const exp = await kv.get(`${expKey}:${owner}`);
    if (exp && Date.now() > parseInt(exp)) {
        await kv.delete(`${idKey}:${owner}`);
        await kv.delete(`${expKey}:${owner}`);
        return null;
    }
    return id;
}

const stateActions = {
    lock: { set: (kv, o, u, m) => { kv.put(`reply_target:${o}`, u); kv.put(`reply_target_expire:${o}`, (Date.now() + m * 60000).toString()); }, key: 'reply_target', del: (kv, o) => { kv.delete(`reply_target:${o}`); kv.delete(`reply_target_expire:${o}`); } },
    ban: { set: (kv, o, u, m) => { kv.put(`ban:${o}`, u); kv.put(`ban_expire:${o}`, (Date.now() + m * 60000).toString()); }, key: 'ban', del: (kv, o) => { kv.delete(`ban:${o}`); kv.delete(`ban_expire:${o}`); } }
};

const userCache = {
    async get(kv) { return JSON.parse(await kv.get('recent_users') || '[]'); },
    async add(kv, user) {
        let list = await this.get(kv);
        list = list.filter(u => u.id !== user.id);
        list.unshift(user);
        if (list.length > CONSTANTS.MAX_RECENT_USERS) list = list.slice(0, CONSTANTS.MAX_RECENT_USERS);
        await kv.put('recent_users', JSON.stringify(list));
    },
    filter(list, showGroups) {
        return showGroups ? list : list.filter(u => {
            if (u.isGroup === false) return true;
            if (u.isGroup === true) return false;
            return !u.id?.startsWith('-100');
        });
    }
};

const sentKeyboard = (target, showUnlock = true) => ({
    inline_keyboard: [[
        { text: '🚫 封禁该用户', callback_data: `ban_${target}` },
        ...(showUnlock ? [{ text: '🔗 取消固定回复', callback_data: `unlock_${target}` }] : [])
    ]]
});

// 通用用户选择菜单键盘
const userSelectKeyboard = (users, page, prefix) => ({
    inline_keyboard: [
        ...users.slice((page - 1) * CONSTANTS.PAGE_SIZE, page * CONSTANTS.PAGE_SIZE).map(u => [{ text: `${u.name || u.id} (${u.id})`, callback_data: `${prefix}sel_${u.id}` }]),
        [
            (page > 1 ? { text: '← 上一页', callback_data: `${prefix}page_${page - 1}` } : { text: ' ', callback_data: 'noop' }),
            (page < Math.ceil(users.length / CONSTANTS.PAGE_SIZE) ? { text: '下一页 →', callback_data: `${prefix}page_${page + 1}` } : { text: ' ', callback_data: 'noop' })
        ]
    ]
});

async function getConfig(kv, owner, turnstileEnvOn) {
    const raw = await kv.get(`config:admin:${owner}`);
    if (!raw) return { block_group: true, math_verify: false, turnstile: turnstileEnvOn };
    return JSON.parse(raw);
}

const toggleKeyboard = (cfg, turnstileEnvOn) => {
    const verifyText = `验证 ${(cfg.math_verify || cfg.turnstile) ? '🟢' : '🔴'}`;
    const btns = [
        [{ text: `屏蔽群组消息 ${cfg.block_group ? '🟢' : '🔴'}`, callback_data: 'toggle_block_group' }],
        [{ text: verifyText, callback_data: 'verify_menu' }],
        [{ text: '📢 群发', callback_data: 'broadcast_menu' }]
    ];
    return { inline_keyboard: btns };
};

const verifyMenuKeyboard = (cfg, turnstileEnvOn) => {
    const btns = [];
    btns.push([{ text: `算术验证 ${cfg.math_verify ? '🟢' : '🔴'}`, callback_data: 'toggle_math_verify' }]);
    if (turnstileEnvOn) {
        btns.push([{ text: `网页验证 ${cfg.turnstile ? '🟢' : '🔴'}`, callback_data: 'toggle_turnstile' }]);
    }
    btns.push([{ text: '🔙 返回', callback_data: 'back_to_main' }]);
    return { inline_keyboard: btns };
};

const broadcastSelectKeyboard = (users, selected, showGroups) => {
    const btns = [];
    // 显示用户列表（每人一行，已选标记 ✅）
    for (const u of users) {
        const checked = selected.includes(u.id) ? '✅ ' : '';
        const tag = u.isGroup ? '👥 ' : '👤 ';
        btns.push([{ text: `${checked}${tag}${u.name || u.id} (${u.id})`, callback_data: `bsel_${u.id}` }]);
    }
    // 底部操作栏
    const bottomRow = [];
    if (users.length > 0 && selected.length < users.length) {
        bottomRow.push({ text: '全选', callback_data: 'bselect_all' });
    }
    if (selected.length > 0) {
        if (selected.length === users.length) bottomRow.push({ text: '取消全选', callback_data: 'bdeselect_all' });
        bottomRow.push({ text: `✅ 确认发送 (${selected.length})`, callback_data: 'bconfirm' });
    }
    bottomRow.push({ text: showGroups ? '🙋 只看用户' : '👥 显示群聊', callback_data: 'btoggle_groups' });
    bottomRow.push({ text: '取消', callback_data: 'bcancel' });
    if (bottomRow.length) btns.push(bottomRow);
    return { inline_keyboard: btns };
};
const statusButtons = (userId, locked, banned) => ({
    inline_keyboard: [
        [{ text: '跳转到用户', url: `tg://user?id=${userId}` }],
        [
            { text: locked ? '🔗 取消固定回复' : '🔗 固定回复该用户', callback_data: `${locked ? 'unlock' : 'lock'}_${userId}` },
            { text: banned ? '🚫 解除封禁' : '🚫 封禁该用户', callback_data: `${banned ? 'unban' : 'ban'}_${userId}` }
        ]
    ]
});

const htmlCard = (title, message, extra = '') => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { min-height: 100vh; display: flex; align-items: center; justify-content: center; font-family: 'Segoe UI', system-ui, sans-serif; background: #0f0f0f; padding: 20px; }
        .card { background: rgba(30,30,30,0.95); backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.08); border-radius: 24px; box-shadow: 0 20px 40px rgba(0,0,0,0.5); padding: 40px 30px; max-width: 420px; width: 100%; text-align: center; animation: fadeInUp 0.5s ease; }
        @keyframes fadeInUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        h1 { font-size: 28px; font-weight: 600; color: #e0e0e0; margin-bottom: 8px; }
        .subtitle { color: #aaa; font-size: 15px; margin-bottom: 30px; }
        .cf-turnstile { display: flex; justify-content: center; }
    </style>
    ${extra}
</head>
<body>
    <div class="card">
        <h1>${title}</h1>
        ${message}
    </div>
</body>
</html>`;

async function isVerified(userId, env) {
    const key = String(userId);
    // 先查全局缓存（最快的，当前 worker 所有请求共享）
    if (verifiedCache.has(key)) return true;
    // 再查 Cache API（同边缘节点共享）
    try {
        const cacheKey = `https://wegram-verify/verified:${key}`;
        const cached = await caches.default.match(cacheKey);
        if (cached) { verifiedCache.set(key, true); return true; }
    } catch {}
    // 最后查 KV（持久化）
    const kv = env.BOT_KV;
    const kvVal = await kv.get(`verified:${key}`);
    if (kvVal) {
        verifiedCache.set(key, true);
        return true;
    }
    return false;
}

async function markVerified(userId, env) {
    const key = String(userId);
    verifiedCache.set(key, true);
    const ttl = endOfDayTtl();
    if (ttl <= 0) return;
    try { await env.BOT_KV.put(`verified:${key}`, '1', { expirationTtl: ttl }); } catch {}
    try {
        const cacheKey = `https://wegram-verify/verified:${key}`;
        await caches.default.put(cacheKey, new Response('1', { headers: { 'Cache-Control': `max-age=${ttl}` } }));
    } catch {}
}

async function getOrCreateVerifyToken(kv, userId) {
    const pendingKey = `pending_verify:${userId}`;
    const pendingData = await kv.get(pendingKey);
    if (pendingData) {
        const [token, timestamp] = pendingData.split(':');
        const remaining = Math.max(0, CONSTANTS.VERIFY_TOKEN_EXPIRE_SEC - Math.floor((Date.now() - parseInt(timestamp)) / 1000));
        if (remaining > 0) return { token, remaining };
        await kv.delete(pendingKey);
        await kv.delete(`verify_token:${token}`);
    }
    const token = crypto.randomUUID();
    await kv.put(`verify_token:${token}`, userId, { expirationTtl: CONSTANTS.VERIFY_TOKEN_EXPIRE_SEC });
    await kv.put(pendingKey, `${token}:${Date.now()}`, { expirationTtl: CONSTANTS.VERIFY_TOKEN_EXPIRE_SEC });
    return { token, remaining: CONSTANTS.VERIFY_TOKEN_EXPIRE_SEC };
}

async function deleteVerifyToken(kv, userId) {
    const pendingKey = `pending_verify:${userId}`;
    const pendingData = await kv.get(pendingKey);
    if (pendingData) {
        const [token] = pendingData.split(':');
        await kv.delete(`verify_token:${token}`);
    }
    await kv.delete(pendingKey);
}

// 获取用户名（tg.getChat 封装）
async function getUserName(tg, userId) {
    try {
        const info = await tg('getChat', { chat_id: parseInt(userId) });
        if (info.ok) {
            const u = info.result || {};
            return u.username ? `@${u.username}` : (u.first_name || '用户');
        }
    } catch { }
    return '未知用户';
}

// 发送已发送确认消息
async function sendSentConfirm(tg, chatId, target, targetName) {
    await tg('sendMessage', {
        chat_id: chatId,
        text: `📤 已发送给 ${targetName} (${target})`,
        reply_markup: sentKeyboard(target)
    });
}

// ======== 管理员命令处理 ========
// 通用用户选择与设置函数
const handleUserSelectCommand = async (args, kv, owner, tg, chatId, config) => {
    const { cmd, prefix, successMsg, noUserMsg, usageMsg } = config;
    if (!args[1]) {
        const users = await userCache.get(kv);
        if (users.length) {
            await tg('sendMessage', { chat_id: chatId, text: `请选择${prefix}对象（第1页）`, reply_markup: userSelectKeyboard(users, 1, cmd) });
        } else {
            await tg('sendMessage', { chat_id: chatId, text: noUserMsg });
        }
        return true;
    }
    if (!/^-?\d+$/.test(args[1])) {
        await tg('sendMessage', { chat_id: chatId, text: usageMsg });
        return true;
    }
    const mins = parseInt(args[2]) || CONSTANTS.DEFAULT_DURATION_MIN;
    stateActions[cmd].set(kv, owner, args[1], mins);
    await tg('sendMessage', { chat_id: chatId, text: successMsg(args[1], mins) });
    return true;
};

const adminCmdHandlers = {
    '/lock': (args, kv, owner, tg, chatId) => handleUserSelectCommand(args, kv, owner, tg, chatId, {
        cmd: 'lock',
        prefix: '固定回复',
        noUserMsg: '❌ 暂无最近联系人，请使用：/lock <用户数字ID> [分钟]',
        usageMsg: '❌ 用法：/lock <用户数字ID> [分钟]',
        successMsg: (id, mins) => `✅ 已设置固定回复目标：${id}，时长 ${mins} 分钟。`
    }),
    '/unlock': async (args, kv, owner, tg, chatId) => {
        stateActions.lock.del(kv, owner);
        await tg('sendMessage', { chat_id: chatId, text: '🔓 已取消固定回复。' });
    },
    '/ban': (args, kv, owner, tg, chatId) => handleUserSelectCommand(args, kv, owner, tg, chatId, {
        cmd: 'ban',
        prefix: '要封禁的',
        noUserMsg: '❌ 暂无最近联系人，请使用：/ban <用户数字ID> [分钟]',
        usageMsg: '❌ 用法：/ban <用户数字ID> [分钟]',
        successMsg: (id, mins) => `🚫 已封禁用户 ${id}，时长 ${mins} 分钟。`
    }),
    '/unban': async (args, kv, owner, tg, chatId) => {
        const expStr = await kv.get(`ban_expire:${owner}`);
        if (args.length >= 2) {
            const reduce = parseInt(args[1]) || 0;
            if (expStr) {
                let exp = parseInt(expStr) - reduce * 60000;
                if (exp <= Date.now()) {
                    await kv.delete(`ban:${owner}`);
                    await kv.delete(`ban_expire:${owner}`);
                    await tg('sendMessage', { chat_id: chatId, text: '🔓 封禁时间已归零，已解除封禁。' });
                } else {
                    await kv.put(`ban_expire:${owner}`, exp.toString());
                    await tg('sendMessage', { chat_id: chatId, text: `⏱️ 已减少封禁时间 ${reduce} 分钟，剩余约 ${Math.ceil((exp - Date.now()) / 60000)} 分钟。` });
                }
            } else {
                await tg('sendMessage', { chat_id: chatId, text: '❌ 当前没有有效的封禁。' });
            }
        } else {
            await kv.delete(`ban:${owner}`);
            await kv.delete(`ban_expire:${owner}`);
            await tg('sendMessage', { chat_id: chatId, text: '🔓 已解除所有封禁。' });
        }
    },
    '/unverify': async (args, kv, owner, tg, chatId) => {
        let targetId = args[1];
        if (!targetId || !/^\d+$/.test(targetId)) {
            await tg('sendMessage', { chat_id: chatId, text: '❌ 用法：/unverify <用户数字ID>' });
            return;
        }
        verifiedCache.delete(targetId);
        await kv.delete(`verified:${targetId}`);
        try { await caches.default.delete(`https://wegram-verify/verified:${targetId}`); } catch { }
        const stillThere = await kv.get(`verified:${targetId}`);
        await tg('sendMessage', {
            chat_id: chatId,
            text: stillThere
                ? `❌ 清除失败：key 仍存在 (${stillThere})`
                : `🔄 已清除用户 ${targetId} 的验证状态，该用户下次发消息时需要重新验证。`
        });
    },
    '/broadcast': async (args, kv, owner, tg, chatId) => {
        const ids = args.slice(1).filter(id => /^\d+$/.test(id));
        if (!ids.length) {
            await tg('sendMessage', { chat_id: chatId, text: '❌ 用法：/broadcast <用户ID1> [用户ID2 ...]' });
            return;
        }
        await setBroadcastState(kv, owner, { selected: ids, step: 'awaiting_content' });
        await tg('sendMessage', {
            chat_id: chatId,
            text: `📝 已选择 ${ids.length} 位用户，请发送你要群发的消息（支持文字/图片/文件等）。\n\n发送 /cancel 取消群发。`
        });
    },
    '/id': async (args, kv, owner, tg, chatId) => {
        const users = await userCache.get(kv);
        if (!users.length) {
            await tg('sendMessage', { chat_id: chatId, text: '📭 暂无最近联系人。' });
            return;
        }
        const lines = users.map((u, i) => `${i + 1}. ${u.name || '用户'} — ${u.id}`);
        await tg('sendMessage', { chat_id: chatId, text: `📋 最近联系人（共 ${users.length} 人）：\n\n${lines.join('\n')}` });
    }
};

function handleAdminCmd(args, kv, owner, tg, chatId) {
    const cmd = args?.[0];
    const handler = cmd && adminCmdHandlers[cmd];
    if (handler) return handler(args, kv, owner, tg, chatId);
    return null;
}

// 群发相关 KV 辅助
async function getBroadcastState(kv, owner) {
    const raw = await kv.get(`broadcast:${owner}`);
    return raw ? JSON.parse(raw) : null;
}
async function setBroadcastState(kv, owner, state) {
    await kv.put(`broadcast:${owner}`, JSON.stringify(state), { expirationTtl: CONSTANTS.BROADCAST_EXPIRE_SEC });
}
async function clearBroadcastState(kv, owner) {
    await kv.delete(`broadcast:${owner}`);
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const prefix = env.PREFIX || 'public';
        const base = `${url.protocol}//${url.hostname}`;

        if (url.pathname.startsWith(`/${prefix}/turnstile/verify`)) return handleTurnstileVerify(request, env);

        if (url.pathname === `/${prefix}/webhook`) {
            if (env.SECRET_TOKEN && request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.SECRET_TOKEN) {
                return new Response('Unauthorized', { status: 401 });
            }
            const update = await request.json();
            await handleUpdate(update, env, base);
            return new Response('OK');
        }

        if (url.pathname === `/${prefix}/install`) {
            const botToken = env.BOT_TOKEN;
            const ownerId = parseInt(env.ADMIN_UID);
            const webhookUrl = `${base}/${prefix}/webhook`;

            const res = await (await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: webhookUrl, allowed_updates: ['message', 'callback_query'], secret_token: env.SECRET_TOKEN })
            })).json();

            const setCmds = (list, scope) => fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ commands: list.map(([c, d]) => ({ command: c, description: d })), scope })
            });
            await setCmds([["start", "显示管理员信息"], ["help", "查看所有命令用法"], ["lock", "固定回复用户 /lock <ID> [分钟]"], ["unlock", "取消固定回复"], ["ban", "封禁用户 /ban <ID> [分钟]"], ["unban", "解封或减少时间 /unban [分钟]"], ["unverify", "清除用户验证 /unverify <ID>"], ["id", "列出最近联系人 ID"], ["cancel", "取消当前操作"]], { type: "chat", chat_id: ownerId });
            await setCmds([["start", "了解如何使用"]], {});

            return new Response(JSON.stringify({ success: res.ok, message: res.ok ? 'Webhook installed' : res.description }), { status: res.ok ? 200 : 400 });
        }

        return new Response('Open Wegram Bot is running');
    }
};

async function handleUpdate(update, env, baseUrl) {
    if (update.callback_query) return handleCallback(update.callback_query, env);

    const msg = update.message;
    if (!msg) return;
    const { text, chat, reply_to_message, caption } = msg;
    const chatId = chat.id;
    const owner = parseInt(env.ADMIN_UID);
    const isOwner = chatId === owner;
    const kv = env.BOT_KV;
    const prefix = env.PREFIX || 'public';
    const verifyDomain = env.VERIFY_DOMAIN ? `https://${env.VERIFY_DOMAIN}` : baseUrl;
    const turnstileOn = !!(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY);
    const tg = createApi(env.BOT_TOKEN);
    const cfg = await getConfig(kv, owner, turnstileOn);

    if (!isOwner && chatId.toString().startsWith('-100') && cfg.block_group) return;

    if (text?.startsWith('/start')) {
        if (isOwner) {
            const [me, chatData] = await Promise.all([
                tg('getMe'),
                tg('getChat', { chat_id: owner })
            ]);
            const u = chatData.result || {};
            const cfg = await getConfig(kv, owner, turnstileOn);
            await tg('sendMessage', {
                chat_id: chatId,
                text: `AG ChatBridge Bot\n\n👤 管理员信息：\n姓名：${u.first_name || '管理员'}\n用户名：${u.username ? '@' + u.username : '无'}\n数字ID：${u.id || owner}\n\n🤖 机器人：${me.result?.first_name || '机器人'}\n绑定状态：已激活\n\n🔧 功能开关：`,
                reply_markup: toggleKeyboard(cfg, turnstileOn)
            });
        } else {
            await tg('sendMessage', { chat_id: chatId, text: '这是一个双向机器人，我会尽快回复。' });
        }
        return;
    }

    if (text?.startsWith('/help')) {
        const v = turnstileOn ? '- 新用户首次使用需完成人机验证（一次性链接，5分钟有效）。' : '- 人机验证未启用，新用户可直接使用。';
        await tg('sendMessage', {
            chat_id: chatId,
            text: `📖 命令列表：\n\n/start - 显示管理员信息\n/help - 查看本帮助\n/id - 列出最近联系人 ID\n\n🔗 固定回复：\n/lock <用户ID> [分钟] - 固定回复某用户（默认${CONSTANTS.DEFAULT_DURATION_MIN}分钟）\n/unlock - 取消固定回复\n\n🚫 封禁管理：\n/ban <用户ID> [分钟] - 封禁某用户（默认${CONSTANTS.DEFAULT_DURATION_MIN}分钟）\n/unban - 立即解除封禁\n/unban <分钟> - 减少封禁剩余时间\n\n🔄 验证管理：\n/unverify <用户ID> - 清除该用户当天验证状态\n\n💡 使用提示：\n- 引用回复消息可以精准转发，且支持多次回复同一条。\n${v}\n- 群组消息（-100开头）将被自动忽略。\n- 无回复目标时直接发消息会弹出近期用户选择菜单。`
        });
        return;
    }

    if (isOwner) {
        const args = text?.trim().split(/\s+/);
        if (await handleAdminCmd(args, kv, owner, tg, chatId)) return;

        // 检查是否有待发送的群发
        const bState = await getBroadcastState(kv, owner);
        if (bState && bState.step === 'awaiting_content') {
            if (text === '/cancel') {
                await clearBroadcastState(kv, owner);
                await tg('sendMessage', { chat_id: chatId, text: '❌ 已取消群发。' });
                return;
            }
            const targets = bState.selected;
            let success = 0, fail = 0;
            for (const targetId of targets) {
                try {
                    await tg('copyMessage', { chat_id: parseInt(targetId), from_chat_id: chatId, message_id: msg.message_id });
                    success++;
                } catch {
                    fail++;
                }
            }
            await clearBroadcastState(kv, owner);
            await tg('sendMessage', {
                chat_id: chatId,
                text: `📢 群发完成：成功 ${success} 人${fail ? `，失败 ${fail} 人` : ''}`
            });
            return;
        }

        if (reply_to_message) {
            const key = `reply_map_${reply_to_message.message_id}`;
            let target = await kv.get(key);
            if (!target && reply_to_message.text) {
                const m = reply_to_message.text.match(/\((\d+)\)/);
                if (m) target = m[1];
            }
            if (target) {
                stateActions.lock.set(kv, owner, target, CONSTANTS.DEFAULT_DURATION_MIN);
                await tg('copyMessage', { chat_id: parseInt(target), from_chat_id: chatId, message_id: msg.message_id });
                await sendSentConfirm(tg, chatId, target, await getUserName(tg, target));
            }
            return;
        }

        const replyTarget = await getState(kv, owner, 'reply');
        if (replyTarget && (text || caption) && !text?.startsWith('/')) {
            await tg('copyMessage', { chat_id: parseInt(replyTarget), from_chat_id: chatId, message_id: msg.message_id });
            await sendSentConfirm(tg, chatId, replyTarget, await getUserName(tg, replyTarget));
            return;
        }

        if (!text?.startsWith('/')) {
            const users = await userCache.get(kv);
            if (users.length) {
                await tg('sendMessage', { chat_id: chatId, text: '请选择回复对象（第1页）', reply_markup: userSelectKeyboard(users, 1, '') });
            } else {
                await tg('sendMessage', { chat_id: chatId, text: '目前没有可以选择的用户。' });
            }
        }
        return;
    }

    // 普通用户处理
    const banned = await getState(kv, owner, 'ban');
    if (banned && banned === chatId.toString()) {
        await tg('sendMessage', { chat_id: chatId, text: '⚠️ 你已被管理员限制，请稍后再试。' });
        return;
    }

    // 检查算术验证答案
    if (cfg.math_verify && text) {
        const mathAnswer = await kv.get(`math_verify:${chatId}`);
        if (mathAnswer) {
            if (text.trim() === mathAnswer) {
                await kv.delete(`math_verify:${chatId}`);
                await markVerified(chatId, env);
                await tg('sendMessage', { chat_id: chatId, text: '✅ 验证通过，你现在可以继续使用机器人了。' });
            } else {
                // 答案错误：删除旧题，让下一步重新出题
                await kv.delete(`math_verify:${chatId}`);
                await tg('sendMessage', { chat_id: chatId, text: '❌ 答案错误，已生成新题目。' });
            }
            return;
        }
    }

    // 验证逻辑：独立检查算术验证和 Turnstile 验证
    if (cfg.math_verify || (cfg.turnstile && turnstileOn)) {
        const verified = await isVerified(chatId, env);
        if (!verified) {
            // debug: 直接读一次 verified key 确认值
            const directCheck = await kv.get(`verified:${chatId}`);
            if (directCheck) {
                // KV 有值但 isVerified 返回 false — 不会走到这里，因为 isVerified 也是读 KV
            }
            await kv.put(`_debug_verify_${chatId}`, `not_verified_${Date.now()}`, { expirationTtl: CONSTANTS.VERIFY_TOKEN_EXPIRE_SEC });
            let sentSomething = false;

            // 算术验证（cfg.math_verify 独立开关）
            if (cfg.math_verify) {
                const mathAnswer = await kv.get(`math_verify:${chatId}`);
                if (!mathAnswer) {
                    const a = Math.floor(Math.random() * 50) + 1;
                    const b = Math.floor(Math.random() * 50) + 1;
                    const answer = a + b;
                    await kv.put(`math_verify:${chatId}`, answer.toString(), { expirationTtl: CONSTANTS.MATH_VERIFY_EXPIRE_SEC });
                    await tg('sendMessage', {
                        chat_id: chatId,
                        text: `👋 欢迎使用本机器人，请先完成验证：${a} + ${b} = ?（请输入答案，5分钟内有效）`
                    });
                    sentSomething = true;
                }
            }

            // 网页人机验证（cfg.turnstile 独立开关，需要 Turnstile 环境变量）
            if (cfg.turnstile && turnstileOn) {
                const { token, remaining } = await getOrCreateVerifyToken(kv, chatId.toString());
                // 使用 VERIFY_DOMAIN 作为 Pages 域名，否则使用 Worker 内置页面
                let verifyUrl;
                if (env.VERIFY_DOMAIN) {
                    // 如果配置了 VERIFY_DOMAIN，使用独立的 Pages 页面
                    verifyUrl = `https://${env.VERIFY_DOMAIN}?token=${token}`;
                } else {
                    // 否则使用 Worker 内置页面（保留旧行为）
                    verifyUrl = `${verifyDomain}/${prefix}/turnstile/verify/${token}`;
                }
                await tg('sendMessage', {
                    chat_id: chatId,
                    text: sentSomething
                        ? `另外，你也可以通过人机验证链接完成验证（${remaining} 秒后过期）。`
                        : `👋 欢迎使用本机器人，请先完成人机验证（链接将 ${remaining} 秒后过期）。`,
                    reply_markup: { inline_keyboard: [[{ text: '🤖 点击进行人机验证', url: verifyUrl }]] }
                });
                sentSomething = true;
            }

            if (sentSomething) return;
        }
    }

    const fwd = await tg('forwardMessage', { chat_id: owner, from_chat_id: chatId, message_id: msg.message_id });
    if (fwd.ok && fwd.result) {
        await kv.put(`reply_map_${fwd.result.message_id}`, chatId.toString(), { expirationTtl: CONSTANTS.REPLY_MAP_EXPIRE_SEC });
    }
    const userName = chat.username ? `@${chat.username}` : (chat.first_name || '用户');
    await userCache.add(kv, { id: chatId.toString(), name: userName, isGroup: chatId.toString().startsWith('-100') });

    // 通知管理员（含防重复机制：10分钟内同一用户不重复通知）
    const replyTargetNow = await getState(kv, owner, 'reply');
    const lastNotifyKey = `last_notify:${chatId}`;
    const lastNotify = await kv.get(lastNotifyKey);
    const isDuplicate = lastNotify && (Date.now() - parseInt(lastNotify) < CONSTANTS.NOTIFY_COOLDOWN_SEC * 1000);

    if (!(replyTargetNow === chatId.toString() || isDuplicate)) {
        await kv.put(lastNotifyKey, Date.now().toString(), { expirationTtl: CONSTANTS.NOTIFY_COOLDOWN_SEC });
        const [locked, ban] = [replyTargetNow, await getState(kv, owner, 'ban')];
        await tg('sendMessage', {
            chat_id: owner,
            text: `用户: ${userName} (${chatId}) 发来消息`,
            reply_markup: statusButtons(chatId.toString(), locked === chatId.toString(), ban === chatId.toString())
        });
    }
}

async function handleCallback(cb, env) {
    const { data, message, from } = cb;
    const chatId = message.chat.id;
    const msgId = message.message_id;
    const turnstileOn = !!(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY);
    const owner = parseInt(env.ADMIN_UID);
    const kv = env.BOT_KV;
    const tg = createApi(env.BOT_TOKEN);

    if (from.id !== owner) {
        return tg('answerCallbackQuery', { callback_query_id: cb.id, text: '只有管理员可使用此按钮。', show_alert: true });
    }

    const refreshButtons = async (userId) => {
        const [lockId, banId] = await Promise.all([
            getState(kv, owner, 'reply'),
            getState(kv, owner, 'ban')
        ]);
        return tg('editMessageReplyMarkup', {
            chat_id: chatId, message_id: msgId,
            reply_markup: statusButtons(userId, lockId === userId, banId === userId)
        });
    };

    if (data === 'verify_menu') {
        const cfg = await getConfig(kv, owner, turnstileOn);
        return tg('editMessageReplyMarkup', {
            chat_id: chatId, message_id: msgId,
            reply_markup: verifyMenuKeyboard(cfg, turnstileOn)
        });
    }

    if (data === 'back_to_main') {
        const cfg = await getConfig(kv, owner, turnstileOn);
        const u = (await tg('getChat', { chat_id: owner })).result || {};
        const me = (await tg('getMe')).result || {};
        return tg('editMessageText', {
            chat_id: chatId, message_id: msgId,
            text: `AG ChatBridge Bot\n\n👤 管理员信息：\n姓名：${u.first_name || '管理员'}\n用户名：${u.username ? '@' + u.username : '无'}\n数字ID：${u.id || owner}\n\n🤖 机器人：${me.first_name || '机器人'}\n绑定状态：已激活\n\n🔧 功能开关：`,
            reply_markup: toggleKeyboard(cfg, turnstileOn)
        });
    }

    if (data === 'toggle_block_group' || data === 'toggle_math_verify' || data === 'toggle_turnstile') {
        const cfg = await getConfig(kv, owner, turnstileOn);
        if (data === 'toggle_block_group') {
            cfg.block_group = !cfg.block_group;
        } else if (data === 'toggle_math_verify') {
            if (cfg.math_verify) cfg.math_verify = false;
            else { cfg.math_verify = true; cfg.turnstile = false; }
        } else {
            if (cfg.turnstile) cfg.turnstile = false;
            else { cfg.turnstile = true; cfg.math_verify = false; }
        }
        await kv.put(`config:admin:${owner}`, JSON.stringify(cfg));
        if (data === 'toggle_block_group') {
            // 主菜单按钮，更新主面板
            const u = (await tg('getChat', { chat_id: owner })).result || {};
            const me = (await tg('getMe')).result || {};
            await tg('editMessageText', {
                chat_id: chatId, message_id: msgId,
                text: `AG ChatBridge Bot\n\n👤 管理员信息：\n姓名：${u.first_name || '管理员'}\n用户名：${u.username ? '@' + u.username : '无'}\n数字ID：${u.id || owner}\n\n🤖 机器人：${me.first_name || '机器人'}\n绑定状态：已激活\n\n🔧 功能开关：`,
                reply_markup: toggleKeyboard(cfg, turnstileOn)
            });
        } else {
            // 验证子菜单按钮，留在验证菜单中
            await tg('editMessageReplyMarkup', {
                chat_id: chatId, message_id: msgId,
                reply_markup: verifyMenuKeyboard(cfg, turnstileOn)
            });
        }
        return tg('answerCallbackQuery', { callback_query_id: cb.id, text: '✅ 已切换', show_alert: false });
    }

    // 群发：选择用户
    if (data === 'broadcast_menu') {
        const users = await userCache.get(kv);
        if (!users.length) {
            return tg('answerCallbackQuery', { callback_query_id: cb.id, text: '📭 暂无最近联系人。', show_alert: true });
        }
        const broadcastState = { selected: [], step: 'select', showGroups: false };
        await setBroadcastState(kv, owner, broadcastState);
        const filtered = userCache.filter(users, false);
        await tg('editMessageText', {
            chat_id: chatId, message_id: msgId,
            text: `📢 群发 - 选择接收用户（共 ${filtered.length} 人，总联系人 ${users.length} 人）：\n点击用户切换选择，选完后点"确认发送"。`,
            reply_markup: broadcastSelectKeyboard(filtered, [], false)
        });
        return tg('answerCallbackQuery', { callback_query_id: cb.id });
    }

    if (data === 'btoggle_groups') {
        const users = await userCache.get(kv);
        const bState = await getBroadcastState(kv, owner);
        if (!bState) return;
        bState.showGroups = !bState.showGroups;
        await setBroadcastState(kv, owner, bState);
        const filtered = userCache.filter(users, bState.showGroups);
        // 清除不在当前视图中的选中
        const validIds = new Set(filtered.map(u => u.id));
        bState.selected = bState.selected.filter(id => validIds.has(id));
        await setBroadcastState(kv, owner, bState);
        await tg('editMessageText', {
            chat_id: chatId, message_id: msgId,
            text: `📢 群发 - 选择接收用户（共 ${filtered.length} 人，总联系人 ${users.length} 人）：\n点击用户切换选择，选完后点"确认发送"。`,
            reply_markup: broadcastSelectKeyboard(filtered, bState.selected, bState.showGroups)
        });
        return tg('answerCallbackQuery', { callback_query_id: cb.id });
    }

    if (data === 'bselect_all') {
        const users = await userCache.get(kv);
        const bState = await getBroadcastState(kv, owner);
        if (!bState) return;
        const filtered = userCache.filter(users, bState.showGroups);
        bState.selected = filtered.map(u => u.id);
        await setBroadcastState(kv, owner, bState);
        await tg('editMessageReplyMarkup', {
            chat_id: chatId, message_id: msgId,
            reply_markup: broadcastSelectKeyboard(filtered, bState.selected, bState.showGroups)
        });
        return tg('answerCallbackQuery', { callback_query_id: cb.id });
    }

    if (data === 'bdeselect_all') {
        const users = await userCache.get(kv);
        const bState = await getBroadcastState(kv, owner);
        if (!bState) return;
        const filtered = userCache.filter(users, bState.showGroups);
        bState.selected = [];
        await setBroadcastState(kv, owner, bState);
        await tg('editMessageReplyMarkup', {
            chat_id: chatId, message_id: msgId,
            reply_markup: broadcastSelectKeyboard(filtered, bState.selected, bState.showGroups)
        });
        return tg('answerCallbackQuery', { callback_query_id: cb.id });
    }

    if (data.startsWith('bsel_')) {
        const uid = data.substring(5);
        const users = await userCache.get(kv);
        const bState = await getBroadcastState(kv, owner);
        if (!bState) return;
        const filtered = userCache.filter(users, bState.showGroups);
        const idx = bState.selected.indexOf(uid);
        if (idx >= 0) bState.selected.splice(idx, 1);
        else bState.selected.push(uid);
        await setBroadcastState(kv, owner, bState);
        await tg('editMessageReplyMarkup', {
            chat_id: chatId, message_id: msgId,
            reply_markup: broadcastSelectKeyboard(filtered, bState.selected, bState.showGroups)
        });
        return tg('answerCallbackQuery', { callback_query_id: cb.id });
    }

    if (data === 'bconfirm') {
        const bState = await getBroadcastState(kv, owner);
        if (!bState || !bState.selected.length) {
            return tg('answerCallbackQuery', { callback_query_id: cb.id, text: '❌ 请至少选择一位用户。', show_alert: true });
        }
        bState.step = 'awaiting_content';
        await setBroadcastState(kv, owner, bState);
        await tg('editMessageText', {
            chat_id: chatId, message_id: msgId,
            text: `📝 已选择 ${bState.selected.length} 位用户，请发送你要群发的消息（支持文字/图片/文件等）。\n\n发送 /cancel 取消群发。`
        });
        await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: '取消群发', callback_data: 'bcancel' }]] } });
        return tg('answerCallbackQuery', { callback_query_id: cb.id, text: `✅ 已选 ${bState.selected.length} 人，请发送消息。`, show_alert: false });
    }

    if (data === 'bcancel') {
        await clearBroadcastState(kv, owner);
        const u = (await tg('getChat', { chat_id: owner })).result || {};
        const me = (await tg('getMe')).result || {};
        await tg('editMessageText', {
            chat_id: chatId, message_id: msgId,
            text: `AG ChatBridge Bot\n\n👤 管理员信息：\n姓名：${u.first_name || '管理员'}\n用户名：${u.username ? '@' + u.username : '无'}\n数字ID：${u.id || owner}\n\n🤖 机器人：${me.first_name || '机器人'}\n绑定状态：已激活\n\n🔧 功能开关：`,
            reply_markup: toggleKeyboard(await getConfig(kv, owner, turnstileOn), turnstileOn)
        });
        return tg('answerCallbackQuery', { callback_query_id: cb.id, text: '已取消群发。', show_alert: false });
    }

    if (data.startsWith('page_')) {
        const page = parseInt(data.split('_')[1]);
        const users = await userCache.get(kv);
        await tg('editMessageText', { chat_id: chatId, message_id: msgId, text: `请选择回复对象（第${page}页）` });
        await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: userSelectKeyboard(users, page, '') });
        return tg('answerCallbackQuery', { callback_query_id: cb.id });
    }

    if (data.startsWith('sel_')) {
        const userId = data.substring(4);
        stateActions.lock.set(kv, owner, userId, CONSTANTS.DEFAULT_DURATION_MIN);
        await tg('deleteMessage', { chat_id: chatId, message_id: msgId });
        await tg('sendMessage', { chat_id: chatId, text: `✅ 已设置固定回复目标：${userId}，时长 ${CONSTANTS.DEFAULT_DURATION_MIN} 分钟。` });
        return tg('answerCallbackQuery', { callback_query_id: cb.id, text: '✅ 已设置固定回复目标', show_alert: false });
    }

    if (data.startsWith('banpage_')) {
        const page = parseInt(data.split('_')[1]);
        const users = await userCache.get(kv);
        await tg('editMessageText', { chat_id: chatId, message_id: msgId, text: `请选择要封禁的用户（第${page}页）` });
        await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: userSelectKeyboard(users, page, 'ban') });
        return tg('answerCallbackQuery', { callback_query_id: cb.id });
    }

    if (data.startsWith('bansel_')) {
        const userId = data.substring(6);
        stateActions.ban.set(kv, owner, userId, CONSTANTS.DEFAULT_DURATION_MIN);
        await tg('deleteMessage', { chat_id: chatId, message_id: msgId });
        await tg('sendMessage', { chat_id: chatId, text: `🚫 已封禁用户 ${userId}，时长 ${CONSTANTS.DEFAULT_DURATION_MIN} 分钟。` });
        return tg('answerCallbackQuery', { callback_query_id: cb.id, text: '🚫 已封禁用户', show_alert: false });
    }

    const [action, userId] = data.split('_');
    const act = stateActions[action === 'unlock' ? 'lock' : (action === 'unban' ? 'ban' : null)];
    if (act) {
        if (action === 'lock' || action === 'ban') {
            act.set(kv, owner, userId, CONSTANTS.DEFAULT_DURATION_MIN);
        } else {
            act.del(kv, owner);
        }
        await refreshButtons(userId);
        await tg('answerCallbackQuery', { callback_query_id: cb.id, text: '✅ 操作成功', show_alert: false });
    }
}

async function handleTurnstileVerify(request, env) {
    const prefix = env.PREFIX || 'public';
    const token = new URL(request.url).pathname.split('/').pop();
    if (!token || (!env.TURNSTILE_SITE_KEY && !env.TURNSTILE_SECRET_KEY)) {
        // 检查是否需要 JSON 响应
        const acceptHeader = request.headers.get('accept') || '';
        if (acceptHeader.includes('application/json')) {
            return new Response(JSON.stringify({ success: false, error: 'not_enabled' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        return new Response(htmlCard('人机验证未启用', '<p>功能未配置</p>'), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    const userId = await env.BOT_KV.get(`verify_token:${token}`);
    if (!userId) {
        const acceptHeader = request.headers.get('accept') || '';
        if (acceptHeader.includes('application/json')) {
            return new Response(JSON.stringify({ success: false, error: 'invalid_token' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        return new Response(htmlCard('链接无效', '<p>验证链接已过期或不存在</p>'), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    if (request.method === 'GET') {
        return new Response(htmlCard('🤖 人机验证',
            `<p class="subtitle">请完成下方验证以继续</p><div class="cf-turnstile" data-sitekey="${env.TURNSTILE_SITE_KEY}" data-callback="onTurnstileSuccess" data-theme="dark"></div>
    <form id="verifyForm" method="POST" action="/${prefix}/turnstile/verify/${token}" style="display:none;">
        <input type="hidden" name="cf-turnstile-response" id="cf-response">
        <input type="hidden" name="token" value="${token}">
    </form>
    <script>
        window.onTurnstileSuccess = function(t) {
            document.getElementById('cf-response').value = t;
            document.getElementById('verifyForm').submit();
        };
    </script>`,
            `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`),
            { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
    }
    if (request.method === 'POST') {
        let turnstileToken;
        let clientToken;
        try {
            const contentType = request.headers.get('content-type') || '';
            if (contentType.includes('application/json')) {
                // 来自前端页面的 JSON 请求
                const data = await request.json();
                turnstileToken = data['cf-turnstile-response'];
                clientToken = data.token || token;
            } else {
                // 来自表单提交（旧方式）
                const form = await request.formData();
                turnstileToken = form.get('cf-turnstile-response');
                clientToken = form.get('token') || token;
            }
        } catch (e) {
            return new Response(JSON.stringify({ success: false, error: 'invalid_request' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // 验证 Turnstile
        const verifyResult = await (await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: turnstileToken })
        })).json();

        if (verifyResult.success) {
            await deleteVerifyToken(env.BOT_KV, userId);
            await markVerified(userId, env);
            const tg = createApi(env.BOT_TOKEN);
            await tg('sendMessage', { chat_id: parseInt(userId), text: '✅ 验证通过，你现在可以继续使用机器人了。' });
            // 根据请求类型返回不同响应
            const acceptHeader = request.headers.get('accept') || '';
            if (acceptHeader.includes('application/json')) {
                return new Response(JSON.stringify({ success: true }), {
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            return new Response(htmlCard('✅ 验证成功', '<p>你可以返回 Telegram 继续对话了</p>'), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }

        // 验证失败
        const acceptHeader = request.headers.get('accept') || '';
        if (acceptHeader.includes('application/json')) {
            return new Response(JSON.stringify({ success: false, error: 'verify_failed' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        return new Response(htmlCard('❌ 验证失败', '<p>请返回刷新页面重试</p>'), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
}