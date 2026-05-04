# AG ChatBridge Bot

一个基于 Cloudflare Workers 的 Telegram 双向私聊机器人，支持：

- 用户与管理员的私聊转发
- 固定回复模式（无需每次引用）
- 封禁/解封管理与动态按钮
- 算术验证 + Turnstile 人机验证（可独立开关）
- 广播功能：按钮选取或命令输入，一键转发消息给多个用户
- 近期联系人选择菜单
- 群聊自动过滤，管理员可手动切换显示
- 功能面板：屏蔽群组、验证开关、群发入口

## 一键部署（推荐）

整合 `wrangler.toml` + `package.json`，一条命令部署到 Cloudflare Workers。

### 准备工作

- Node.js 18+
- 一个 Cloudflare 账号
- Telegram Bot Token（在 [@BotFather](https://t.me/BotFather) 获取）
- Telegram 用户数字 ID（在 [@userinfobot](https://t.me/userinfobot) 获取）
- （可选）Cloudflare Turnstile 站点密钥和密钥（开启人机验证）

### 步骤

**1. 安装**
```bash
git clone https://github.com/AGAGAG666/AG-ChatBridge-Bot.git
cd AG-ChatBridge-Bot
npm install
```

**2. 登录 Cloudflare**
```bash
npx wrangler login
```
按提示在浏览器中授权。

**3. 创建 KV 命名空间**
```bash
npx wrangler kv:namespace create "BOT_KV"
```
复制返回的 `id`，编辑 `wrangler.toml` 填入：
```toml
[[kv_namespaces]]
binding = "BOT_KV"
id = "你复制的id"
```

**4. 配置环境变量**
编辑 `wrangler.toml`，填写必填项：
```toml
[vars]
ADMIN_UID = "你的Telegram数字ID"
BOT_TOKEN = "BotFather给你的Token"
SECRET_TOKEN = "随机字符串，建议设置"
```

**5. 部署**
```bash
npx wrangler deploy
```
输出 `https://你的项目名.用户名.workers.dev` 即部署成功。

**6. 安装 Webhook**
浏览器访问：
```
https://你的项目名.用户名.workers.dev/public/install
```
返回 `{"success":true,"message":"Webhook installed and commands set"}` 完成。

---

## 手动部署（Dashboard）

如果不想安装 Node.js，也可以通过 Cloudflare Dashboard 部署。

### 准备工作

同上：Bot Token、用户数字 ID、Turnstile 密钥（可选）

### 步骤

**1. 创建 Worker**
登录 Cloudflare 控制台 → **Workers & Pages** → 创建应用程序 → 选择 **Workers**，将 `worker.js` 内容粘贴到代码编辑器，点击部署。

**2. 配置环境变量**
进入 Worker **Settings → Variables**，添加以下变量：

| 变量名 | 必填 | 说明 |
|--------|------|------|
| `ADMIN_UID` | 是 | 管理员 Telegram 数字 ID |
| `BOT_TOKEN` | 是 | 机器人 Token |
| `PREFIX` | 否 | URL 路径前缀，默认 `public` |
| `SECRET_TOKEN` | 否 | Webhook 安全验证令牌（建议设置） |
| `TURNSTILE_SITE_KEY` | 否 | Turnstile 站点密钥（不填则关闭验证） |
| `TURNSTILE_SECRET_KEY` | 否 | Turnstile 密钥（不填则关闭验证） |
| `VERIFY_DOMAIN` | 否 | 验证页面自定义域名（默认用 Worker 域名） |

**3. 绑定 KV 命名空间**
- 在 Cloudflare 控制台创建一个 KV 命名空间。
- 在 Worker **Settings → KV Namespace Bindings** 中点击 **Add binding**。
- **变量名**填写 `BOT_KV`，选择刚创建的命名空间。

**4. 绑定自定义域（用于验证页面）**
如果设置了 `VERIFY_DOMAIN`（例如 `verify.你的域名.com`），需要将该域名绑定到 Worker：
- 进入 Worker **Triggers → Custom Domains → Add Custom Domain**
- 输入域名并完成 DNS 配置
- 在 Cloudflare Turnstile 设置中也将该域名加入允许列表

如果使用 Worker 默认域名（`*.worker.dev`）：
- 将 `VERIFY_DOMAIN` 设为 Worker 的默认域名
- 在 Turnstile 设置中将默认域名加入允许列表

**5. 安装 Webhook**
访问以下地址完成 Webhook 注册和命令菜单设置：
```
https://你的Worker默认域名/public/install
```
返回 `{"success":true,"message":"Webhook installed and commands set"}` 即成功。

**6. 开始使用**
- 给机器人发消息（如启用验证需先完成人机验证）
- 管理员可使用命令管理

## 架构

详见 [ARCHITECTURE.md](./ARCHITECTURE.md)

### 管理员命令

| 命令 | 说明 |
|------|------|
| `/start` | 查看管理员信息和功能面板 |
| `/help` | 列出所有命令及用法 |
| `/lock <用户ID> [分钟]` | 设置固定回复目标（默认 10 分钟） |
| `/unlock` | 取消固定回复 |
| `/ban <用户ID> [分钟]` | 封禁用户（默认 10 分钟） |
| `/unban [分钟]` | 解封或减少封禁剩余时间 |
| `/unverify <用户ID>` | 清除用户当天验证状态 |
| `/id` | 列出最近联系人 ID |
| `/broadcast <用户ID1> [用户ID2 ...]` | 通过命令指定群发目标 |
| `/cancel` | 取消当前操作（如群发） |

### 工作方式详解

**引用回复 vs 固定回复：**
- 引用回复：管理员引用某条转发来的消息回复，自动通过 `reply_map_` 找到原始用户，同时自动将该用户设为固定回复目标（10 分钟）
- 固定回复：通过 `/lock <ID>` 或按钮操作设置，之后管理员发的所有非命令消息都直接转发给该用户

**防重复通知：**
- 同一用户在 10 分钟内多次发消息，不再重复显示操作按钮

**动态按钮：**
- 管理员收到的每条消息下方有 **固定回复/封禁** 按钮
- 状态实时更新（按钮文字会根据当前状态显示"固定回复"或"取消固定回复"）

**人机验证：**
- 支持算术验证和 Turnstile 网页验证两种方式，在功能面板中独立开关
- 算术验证：随机两位数加法，输入答案即可
- Turnstile：通过 Cloudflare Turnstile 完成验证（一次性链接，5 分钟有效）
- 两种验证互斥，开启一种自动关闭另一种
- 验证通过后当天有效，跨请求通过全局 Map + Cache API + KV 三层缓存加速

**广播（群发）：**
- 点击功能面板"📢 群发"按钮进入用户选择界面
- 默认只显示私聊用户，可点击"显示群聊"切换
- 支持全选/取消全选，确认后发送任意消息（文字/图片/文件等）
- 也可通过 `/broadcast <ID1> <ID2>` 命令直接指定目标
- 发送完成后显示成功/失败统计

**功能面板：**
- 管理员 /start 后显示功能面板
- 屏蔽群组消息：开关群组消息自动过滤
- 验证：点击展开验证设置子菜单
- 群发：进入广播选择界面

## 安全

- Webhook 通过 `X-Telegram-Bot-Api-Secret-Token` header 验证
- 群组消息默认自动过滤（可在功能面板关闭"屏蔽群组消息"）
- 回调按钮仅管理员可操作
- Secret Token 和 Bot Token 等敏感信息通过环境变量注入

## 关于

本项目基于 Open Wegram Bot (OWB) 二次开发，使用 GNU General Public License v3.0 授权。

## 注意事项

- 请勿公开包含敏感信息的变量或配置文件
- 群组消息默认自动过滤（可在功能面板关闭"屏蔽群组消息"）
- 验证启用后，新用户需完成验证才能使用，验证当天有效
