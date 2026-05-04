// 工具函数
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
        if (list.length > 50) list = list.slice(0, 50);
        await kv.put('recent_users', JSON.stringify(list));
    }
};

const sentKeyboard = (target, showUnlock = true) => ({
    inline_keyboard: [[
        { text: '🚫 封禁该用户', callback_data: `ban_${target}` },
        ...(showUnlock ? [{ text: '🔗 取消固定回复', callback_data: `unlock_${target}` }] : [])
    ]]
});

const pageKeyboard = (users, page) => ({
    inline_keyboard: [
        ...users.slice((page - 1) * 5, page * 5).map(u => [{ text: `${u.name || u.id} (${u.id})`, callback_data: `sel_${u.id}` }]),
        [
            (page > 1 ? { text: '← 上一页', callback_data: `page_${page - 1}` } : { text: ' ', callback_data: 'noop' }),
            (page < Math.ceil(users.length / 5) ? { text: '下一页 →', callback_data: `page_${page + 1}` } : { text: ' ', callback_data: 'noop' })
        ]
    ]
});

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
    const cacheKey = `https://wegram-verify/verified:${userId}`;
    const cache = caches.default;
    let resp = await cache.match(cacheKey);
    if (resp) return true;
    const kvVal = await env.BOT_KV.get(`verified:${userId}`);
    if (kvVal) {
        const ttl = endOfDayTtl();
        if (ttl > 0) {
            await cache.put(cacheKey, new Response('1', { headers: { 'Cache-Control': `max-age=${ttl}` } }));
        }
        return true;
    }
    return false;
}

async function markVerified(userId, env) {
    const ttl = endOfDayTtl();
    if (ttl <= 0) return;
    await env.BOT_KV.put(`verified:${userId}`, '1', { expirationTtl: ttl });
    const cacheKey = `https://wegram-verify/verified:${userId}`;
    await caches.default.put(cacheKey, new Response('1', { headers: { 'Cache-Control': `max-age=${ttl}` } }));
}

async function getOrCreateVerifyToken(kv, userId) {
    const pendingKey = `pending_verify:${userId}`;
    const pendingData = await kv.get(pendingKey);
    if (pendingData) {
        const [token, timestamp] = pendingData.split(':');
        const remaining = Math.max(0, 300 - Math.floor((Date.now() - parseInt(timestamp)) / 1000));
        if (remaining > 0) return { token, remaining };
        await kv.delete(pendingKey);
        await kv.delete(`verify_token:${token}`);
    }
    const token = crypto.randomUUID();
    await kv.put(`verify_token:${token}`, userId, { expirationTtl: 300 });
    await kv.put(pendingKey, `${token}:${Date.now()}`, { expirationTtl: 300 });
    return { token, remaining: 300 };
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

// 管理员命令处理
const adminCmdHandlers = {
    '/lock': async (args, kv, owner, tg, chatId) => {
        const mins = parseInt(args[2]) || 10;
        await kv.put(`reply_target:${owner}`, args[1]);
        await kv.put(`reply_target_expire:${owner}`, (Date.now() + mins * 60000).toString());
        await tg('sendMessage', { chat_id: chatId, text: `✅ 已设置固定回复目标：${args[1]}，时长 ${mins} 分钟。` });
    },
    '/unlock': async (args, kv, owner, tg, chatId) => {
        await kv.delete(`reply_target:${owner}`);
        await kv.delete(`reply_target_expire:${owner}`);
        await tg('sendMessage', { chat_id: chatId, text: '🔓 已取消固定回复。' });
    },
    '/ban': async (args, kv, owner, tg, chatId) => {
        const mins = parseInt(args[2]) || 10;
        await kv.put(`ban:${owner}`, args[1]);
        await kv.put(`ban_expire:${owner}`, (Date.now() + mins * 60000).toString());
        await tg('sendMessage', { chat_id: chatId, text: `🚫 已封禁用户 ${args[1]}，时长 ${mins} 分钟。` });
    },
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
        const targetId = args[1];
        await kv.delete(`verified:${targetId}`);
        await caches.default.delete(`https://wegram-verify/verified:${targetId}`);
        await tg('sendMessage', { chat_id: chatId, text: `🔄 已清除用户 ${targetId} 的验证状态（含缓存），该用户下次发消息时需要重新验证。` });
    }
};

function handleAdminCmd(args, kv, owner, tg, chatId) {
    const cmd = args?.[0];
    const handler = cmd && adminCmdHandlers[cmd];
    if (handler) return handler(args, kv, owner, tg, chatId);
    return null;
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
            ctx.waitUntil(handleUpdate(update, env, base));
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
            await setCmds([["start", "显示管理员信息"], ["help", "查看所有命令用法"], ["lock", "固定回复用户 /lock <ID> [分钟]"], ["unlock", "取消固定回复"], ["ban", "封禁用户 /ban <ID> [分钟]"], ["unban", "解封或减少时间 /unban [分钟]"], ["unverify", "清除用户验证 /unverify <ID>"]], { type: "chat", chat_id: ownerId });
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

    if (!isOwner && chatId.toString().startsWith('-100')) return;

    if (text?.startsWith('/start')) {
        if (isOwner) {
            const [me, chatData] = await Promise.all([
                tg('getMe'),
                tg('getChat', { chat_id: owner })
            ]);
            const u = chatData.result || {};
            await tg('sendMessage', { chat_id: chatId, text: `👤 管理员信息：\n姓名：${u.first_name || '管理员'}\n用户名：${u.username ? '@' + u.username : '无'}\n数字ID：${u.id || owner}\n\n🤖 机器人：${me.result?.first_name || '机器人'}\n绑定状态：已激活` });
        } else {
            await tg('sendMessage', { chat_id: chatId, text: '这是一个双向机器人，我会尽快回复。' });
        }
        return;
    }

    if (text?.startsWith('/help')) {
        const v = turnstileOn ? '- 新用户首次使用需完成人机验证（一次性链接，5分钟有效）。' : '- 人机验证未启用，新用户可直接使用。';
        await tg('sendMessage', {
            chat_id: chatId,
            text: `📖 命令列表：\n\n/start - 显示管理员信息\n/help - 查看本帮助\n\n🔗 固定回复：\n/lock <用户ID> [分钟] - 固定回复某用户（默认10分钟）\n/unlock - 取消固定回复\n\n🚫 封禁管理：\n/ban <用户ID> [分钟] - 封禁某用户（默认10分钟）\n/unban - 立即解除封禁\n/unban <分钟> - 减少封禁剩余时间\n\n🔄 验证管理：\n/unverify <用户ID> - 清除该用户当天验证状态\n\n💡 使用提示：\n- 引用回复消息可以精准转发，且支持多次回复同一条。\n${v}\n- 群组消息（-100开头）将被自动忽略。\n- 无回复目标时直接发消息会弹出近期用户选择菜单。`
        });
        return;
    }

    if (isOwner) {
        const args = text?.trim().split(/\s+/);
        if (await handleAdminCmd(args, kv, owner, tg, chatId)) return;

        // 引用回复：自动锁定目标并转发，带确认信息
        if (reply_to_message) {
            const key = `reply_map_${reply_to_message.message_id}`;
            let target = await kv.get(key);
            if (!target && reply_to_message.text) {
                const m = reply_to_message.text.match(/\((\d+)\)/);
                if (m) target = m[1];
            }
            if (target) {
                stateActions.lock.set(kv, owner, target, 10);
                await tg('copyMessage', { chat_id: parseInt(target), from_chat_id: chatId, message_id: msg.message_id });
                await sendSentConfirm(tg, chatId, target, await getUserName(tg, target));
            }
            return;
        }

        // 固定回复转发
        const replyTarget = await getState(kv, owner, 'reply');
        if (replyTarget && (text || caption) && !text?.startsWith('/')) {
            await tg('copyMessage', { chat_id: parseInt(replyTarget), from_chat_id: chatId, message_id: msg.message_id });
            await sendSentConfirm(tg, chatId, replyTarget, await getUserName(tg, replyTarget));
            return;
        }

        // 无目标时弹出选择菜单
        if (!text?.startsWith('/')) {
            const users = await userCache.get(kv);
            if (users.length) {
                await tg('sendMessage', { chat_id: chatId, text: '请选择回复对象（第1页）', reply_markup: pageKeyboard(users, 1) });
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

    if (turnstileOn) {
        const verified = await isVerified(chatId, env);
        if (!verified) {
            const { token, remaining } = await getOrCreateVerifyToken(kv, chatId.toString());
            const verifyUrl = `${verifyDomain}/${prefix}/turnstile/verify/${token}`;
            await tg('sendMessage', {
                chat_id: chatId,
                text: `👋 欢迎使用本机器人，请先完成人机验证（链接将 ${remaining} 秒后过期）。`,
                reply_markup: { inline_keyboard: [[{ text: '🤖 点击进行人机验证', url: verifyUrl }]] }
            });
            return;
        }
    }

    const fwd = await tg('forwardMessage', { chat_id: owner, from_chat_id: chatId, message_id: msg.message_id });
    if (fwd.ok && fwd.result) {
        await kv.put(`reply_map_${fwd.result.message_id}`, chatId.toString(), { expirationTtl: 3600 });
    }
    const userName = chat.username ? `@${chat.username}` : (chat.first_name || '用户');
    await userCache.add(kv, { id: chatId.toString(), name: userName });

    // 通知管理员（含防重复机制）
    const replyTargetNow = await getState(kv, owner, 'reply');
    const lastNotifyKey = `last_notify:${chatId}`;
    const lastNotify = await kv.get(lastNotifyKey);
    const isDuplicate = lastNotify && (Date.now() - parseInt(lastNotify) < 600000);

    if (replyTargetNow === chatId.toString() || isDuplicate) {
        await tg('sendMessage', { chat_id: owner, text: `用户: ${userName} (${chatId}) 发来消息` });
    } else {
        await kv.put(lastNotifyKey, Date.now().toString(), { expirationTtl: 600 });
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

    if (data.startsWith('page_')) {
        const page = parseInt(data.split('_')[1]);
        const users = await userCache.get(kv);
        await tg('editMessageText', { chat_id: chatId, message_id: msgId, text: `请选择回复对象（第${page}页）` });
        await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: pageKeyboard(users, page) });
        return tg('answerCallbackQuery', { callback_query_id: cb.id });
    }

    if (data.startsWith('sel_')) {
        const userId = data.substring(4);
        stateActions.lock.set(kv, owner, userId, 10);
        await tg('deleteMessage', { chat_id: chatId, message_id: msgId });
        return tg('answerCallbackQuery', { callback_query_id: cb.id, text: '✅ 已选择该用户，现在可以直接发送消息给他（10分钟有效）', show_alert: false });
    }

    const [action, userId] = data.split('_');
    const act = stateActions[action === 'unlock' ? 'lock' : (action === 'unban' ? 'ban' : null)];
    if (act) {
        if (action === 'lock' || action === 'ban') {
            act.set(kv, owner, userId, 10);
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
        return new Response(htmlCard('人机验证未启用', '<p>功能未配置</p>'), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    const userId = await env.BOT_KV.get(`verify_token:${token}`);
    if (!userId) return new Response(htmlCard('链接无效', '<p>验证链接已过期或不存在</p>'), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

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
        const form = await request.formData();
        const verifyResult = await (await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: form.get('cf-turnstile-response') })
        })).json();
        if (verifyResult.success) {
            await deleteVerifyToken(env.BOT_KV, userId);
            await markVerified(userId, env);
            const tg = createApi(env.BOT_TOKEN);
            await tg('sendMessage', { chat_id: parseInt(userId), text: '✅ 验证通过，你现在可以继续使用机器人了。' });
            return new Response(htmlCard('✅ 验证成功', '<p>你可以返回 Telegram 继续对话了</p>'), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }
        return new Response(htmlCard('❌ 验证失败', '<p>请返回刷新页面重试</p>'), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
}