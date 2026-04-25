# AG ChatBridge Bot

一个基于 Cloudflare Workers 的 Telegram 双向私聊机器人，支持：
- 📩 用户与管理员的私聊转发
- 🔗 固定回复模式（无需每次引用）
- 🚫 封禁/解封管理与动态按钮
- 🤖 Turnstile 人机验证（可选，带倒计时一次性令牌）
- 👥 近期联系人选择菜单
- 🎨 内建黑色主题验证页面

## 快速部署

### 1. 准备工作
- 一个 Cloudflare 账号
- 一个 Telegram Bot Token（在 [@BotFather](https://t.me/BotFather) 创建）
- 你的 Telegram 用户数字 ID（可以通过 [@userinfobot](https://t.me/userinfobot) 获取）
- （可选）Cloudflare Turnstile 站点密钥和密钥，用于开启人机验证

### 2. 在 Cloudflare Workers 中部署
1. 登录 Cloudflare 控制台 → **Workers & Pages** → 创建应用程序 → 选择 **Workers**。
2. 将 `worker.js` 的内容完整粘贴到代码编辑器。
3. 点击 **部署**。

### 3. 配置环境变量
进入 Worker 的 **Settings → Variables**，添加以下**纯文本**变量：

| 变量名 | 必填 | 说明 |
|--------|------|------|
| `ADMIN_UID` | ✅ | 你的 Telegram 数字 ID |
| `BOT_TOKEN` | ✅ | 机器人 Token |
| `PREFIX` | 可选 | URL 路径前缀，默认 `public` |
| `SECRET_TOKEN` | 可选 | Webhook 安全验证令牌（建议设置） |
| `TURNSTILE_SITE_KEY` | 可选 | Turnstile 站点密钥 (不填则关闭验证) |
| `TURNSTILE_SECRET_KEY` | 可选 | Turnstile 密钥 (不填则关闭验证) |
| `VERIFY_DOMAIN` | 可选 | 用于展示验证页面的自定义域名（例如 `verify.你的域名.com`），不填则使用 Worker 默认域名( `*.worker.dev`) |

### 4. 绑定 KV 命名空间
- 在 Cloudflare 控制台创建一个 KV 命名空间，名称随意。
- 回到 Worker 的 **Settings → KV Namespace Bindings**，点击 **Add binding**。
- **变量名**填写：`BOT_KV`，选择你刚创建的命名空间。

### 5. 绑定自定义域（用于验证页面）
如果你设置了 `VERIFY_DOMAIN` 环境变量（例如 `verify.你的域名.com`），需要将该域名绑定到 Worker：
- 进入 Worker **Triggers** → **Custom Domains** → **Add Custom Domain**。
- 输入 `verify.你的域名.com`，并按提示完成 DNS 配置。
- 同时确保在 Cloudflare Turnstile 设置中，也将这个域名加入允许列表。

## 注意事项
- 如果你使用的是worker所提供的默认域名，此操作仅需要在Cloudflare Turnstile设置将默认域名加入允许列表即可

### 6. 安装 Webhook
访问以下地址完成 Webhook 注册和命令菜单设置：
https://你的域名/public/install



浏览器返回 `{"success":true,"message":"Webhook installed and commands set"}` 即表示成功。

### 7. 开始使用
- 给机器人发送任意消息，根据提示完成人机验证（若已启用）。
- 管理员可使用命令：`/start`、`/help`、`/lock`、`/unlock`、`/ban`、`/unban`、`/unverify`。
- 管理员收到的每条用户消息下方都有快捷操作按钮。

## 功能命令

| 命令 | 说明 |
|------|------|
| `/start` | 查看信息 |
| `/help` | 列出所有命令 |
| `/lock <用户ID> [分钟]` | 设置固定回复目标 |
| `/unlock` | 取消固定回复 |
| `/ban <用户ID> [分钟]` | 封禁用户 |
| `/unban [分钟]` | 解禁或减少封禁时间 |
| `/unverify <用户ID>` | 清除用户验证状态 |

## 开源协议
本项目采用 **GNU General Public License v3.0**。详见 [LICENSE](LICENSE) 文件。

## 注意事项
- 部署后请勿公开包含敏感信息的变量或配置文件（如 `wrangler.toml`）。
- 群组消息（ID 以 `-100` 开头）会被自动忽略。
- Turnstile 验证一旦启用，新用户需在 5 分钟内点击一次性链接完成验证，当天有效。

本项目是基于 Open Wegram Bot (OWB) 开发
原始项目使用 GNU General Public License v3.0 授权