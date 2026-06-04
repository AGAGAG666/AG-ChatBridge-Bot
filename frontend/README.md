# ChatBridge 验证页面

这是一个部署在 Cloudflare Pages 上的独立验证页面，用于配合 ChatBridge Telegram 机器人使用。

## 使用说明

### 1. 配置

在 `index.html` 中修改以下配置：

```javascript
const WORKER_URL = 'https://your-worker.your-name.workers.dev'; // 你的 Worker URL
const TURNSTILE_SITE_KEY = 'your-turnstile-site-key'; // 你的 Turnstile Site Key
```

### 2. 本地开发

```bash
cd frontend
npm run dev
```

### 3. 部署到 Cloudflare Pages

```bash
# 先登录
npx wrangler login

# 部署
npm run deploy
```

### 4. 更新 Worker 配置

在 Worker 中设置 `VERIFY_DOMAIN` 为你的 Pages 域名：

```toml
[vars]
VERIFY_DOMAIN = "your-pages-domain.pages.dev"
```

## 结构

```
frontend/
├── index.html      # 验证页面
├── package.json    # 项目配置
└── README.md       # 说明文档
```
