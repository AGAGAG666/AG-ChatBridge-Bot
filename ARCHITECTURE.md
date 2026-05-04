## 架构

### 路由

| 路径 | 处理函数 | 说明 |
|------|----------|------|
| `/{prefix}/webhook` | `handleUpdate()` | Telegram webhook 入口，处理消息和回调 |
| `/{prefix}/install` | 内联逻辑 | 注册 webhook + 设置 Bot Commands |
| `/{prefix}/turnstile/verify/:token` | `handleTurnstileVerify()` | 人机验证页面和处理 |

### 数据流

1. 用户发消息 → Telegram 调用 webhook（`POST /{prefix}/webhook`）
2. `handleUpdate()` 检查封禁/验证状态：
   - 已封禁 → 返回提示
   - 未验证（启用了 Turnstile）→ 返回验证链接
   - 通过验证 → `forwardMessage` 转发给管理员
3. 管理员收到消息（附带 inline 操作按钮），回复方式：
   - **引用回复** → 通过 `reply_map_` KV 映射找到目标用户，自动转发
   - **固定回复模式** → `/lock <ID>` 后，所有消息直接转发到该用户
   - **无目标** → 弹出近期联系人选择菜单
4. 管理员消息通过 `copyMessage` 转发给用户，保留原消息类型

### KV 存储

| Key 模式 | 用途 | 过期 |
|----------|------|------|
| `reply_target:{owner}` | 当前固定回复目标用户 ID | 自定义 |
| `reply_target_expire:{owner}` | 固定回复过期时间戳 | - |
| `ban:{owner}` | 被封禁用户 ID | 自定义 |
| `ban_expire:{owner}` | 封禁过期时间戳 | - |
| `reply_map_{messageId}` | 转发消息 ID → 用户 ID | 1 小时 |
| `verified:{userId}` | 验证通过标记 | 当天截止 |
| `pending_verify:{userId}` | 待验证令牌+时间戳 | 5 分钟 |
| `verify_token:{token}` | 验证令牌 → 用户 ID | 5 分钟 |
| `recent_users` | 最近联系人列表（最多 50 个） | 永久 |
| `last_notify:{userId}` | 上次通知管理员时间戳 | 10 分钟 |
