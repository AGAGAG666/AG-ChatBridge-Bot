# 部署独立验证页面到 Cloudflare Pages

## 目录结构

```
.
├── worker.js                  # 主 Worker 文件
├── wrangler.toml              # Worker 配置
├── frontend/
│   ├── index.html             # 验证页面
│   ├── package.json           # 前端配置
│   └── README.md              # 前端说明
└── DEPLOY_FRONTEND.md         # 本文件
```

## 步骤 1: 配置验证页面

编辑 `frontend/index.html` 文件，修改配置：

```javascript
const WORKER_URL = 'https://your-worker.your-name.workers.dev'; // 修改为你的 Worker 地址
const TURNSTILE_SITE_KEY = '0x4AAAAAAA...'; // 修改为你的 Turnstile Site Key
```

## 步骤 2: 部署到 Cloudflare Pages

1. 在 `frontend/` 目录下打开终端
2. 登录 Cloudflare
   ```bash
   cd frontend
   npx wrangler login
   ```
3. 部署页面
   ```bash
   npx wrangler pages deploy . --project-name chatbridge-verify
   ```

部署成功后，你会得到一个 Pages 域名，类似：`chatbridge-verify.pages.dev`

## 步骤 3: 更新 Worker 配置

在 `wrangler.toml` 中添加：

```toml
[vars]
VERIFY_DOMAIN = "chatbridge-verify.pages.dev"  # 修改为你的 Pages 域名
```

## 步骤 4: 更新和部署 Worker

```bash
# 在项目根目录
wrangler deploy
```

## 验证

完成以上步骤后，向机器人发送消息，它会发送验证链接，点击链接会跳转到你的 Pages 验证页面。

## 可选: 使用环境变量而不是硬编码

你可以通过 Cloudflare Pages 的环境变量功能，在 Dashboard 中设置 `WORKER_URL` 和 `TURNSTILE_SITE_KEY`，然后修改 `index.html` 来使用它们。
