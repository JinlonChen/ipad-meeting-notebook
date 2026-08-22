# iPad 会议笔记

这是 iPad 会议笔记的 foundation 阶段。目前范围包括认证、会议与分类目录、离线同步基础，以及可安装的 PWA；尚不录音，也不渲染手写 ink。

## 本地启动

需要 Node.js >= 22.12.0。首次启动前，将环境变量样例复制为仓库根目录的本地配置，并在 `.env` 中把 `ADMIN_PASSWORD` 改为足够长的本地管理员密码；按部署环境检查其余配置。`npm run dev` 启动 API 时会自动加载根目录的 `.env`。

```bash
npm install
cp .env.example .env
npm run dev
```

启动后访问：

- Web：http://localhost:5173
- API：http://localhost:8787

Safari 仅允许在安全上下文中使用麦克风。本机 `localhost` 可用于开发测试，但 iPad 上的 `localhost` 指向 iPad 自身，并不是开发电脑的地址；真机测试需要有效的 HTTPS 部署。

## iPad HTTPS 部署前提

同一个公网或私网 HTTPS origin 需要提供 Web，并将 `/api` 反向代理到 API。部署时将 `WEB_ORIGIN` 设置为实际的 HTTPS URL，将 `COOKIE_SECURE` 设置为 `true`，并按网络与代理拓扑调整 `API_HOST`、反向代理和防火墙。仓库当前不提供部署自动化，这些前提需要在部署环境中另行配置。

## 配置安全

本地开发的密码、API 密钥等 secrets 只放在已被 Git 忽略的根 `.env` 中；部署 secrets 使用平台的 secret manager 或受控服务端环境变量。secrets 不得写入前端代码、提交到仓库，或通过前端响应暴露，也不要在 `.env.example` 中填写真实密码或密钥。
