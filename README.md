# iPad 会议笔记

这是 iPad 会议笔记的 foundation 阶段。目前范围包括认证、会议与分类目录、离线同步基础，以及可安装的 PWA；尚不录音，也不渲染手写 ink。

## 本地启动

需要 Node.js >= 22.12.0。首次启动前，将环境变量样例复制为本地配置，并在 `.env` 中把 `ADMIN_PASSWORD` 改为足够长的本地管理员密码；按部署环境检查其余配置。

```bash
npm install
cp .env.example .env
npm run dev
```

启动后访问：

- Web：http://localhost:5173
- API：http://localhost:8787

Safari 仅允许在安全上下文中使用麦克风。本机 `localhost` 可用于开发测试；从 iPad 或其他设备访问时，需要通过 HTTPS 部署后再测试麦克风权限。

## 配置安全

密码、API 密钥等 secrets 只放在 `.env` 中，不得写入前端代码、提交到仓库，或通过前端响应暴露。不要在 `.env.example` 中填写真实密码或密钥。
