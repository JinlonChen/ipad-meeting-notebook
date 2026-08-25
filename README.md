# iPad 会议本

这是面向个人使用的 iPad 会议本 PWA。当前版本提供邮箱密码登录、会议与分类目录、永久会议笔记、本地离线修改、联网自动同步、实时转写、手动生成 AI 总结，以及可恢复的会议录音。

会议录音按 10 秒分片先写入 iPad 本机，断网时继续保存，联网后上传到私有 Supabase Storage；异常关闭后可以结束并保存已录分片。联网录音时，浏览器把 PCM 音频流发送到 Python 中继，由阿里 DashScope 官方 SDK 调用 `qwen3-asr-flash-realtime`，最终转写永久写入 Supabase。录音结束后可以按需生成 AI 总结。原始录音在本机和云端统一保留 48 小时；手写、说话人区分和录音播放尚未实现。

## 本地运行

需要 Node.js 22.12、Python 3.12 或更高版本，以及一个独立的 Supabase 项目。

1. 安装依赖并创建本地配置：

   ```bash
   npm ci
   cp .env.example apps/web/.env.local
   ```

2. 在 `apps/web/.env.local` 中填写 Supabase Project URL、公开 anon key 和中继的公开 HTTPS 地址 `VITE_TRANSCRIPTION_RELAY_URL`。本地开发的 `VITE_BASE_PATH` 保持 `/`。这些值会进入浏览器构建，不能填写服务端密钥。

3. 启动 Web 应用：

   ```bash
   npm run dev -w @meeting/web
   ```

4. 在电脑浏览器打开 `http://localhost:5173`。生产入口直接连接 Supabase，不需要启动仓库中保留的旧 Fastify/SQLite API。

常用检查命令：

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
pip install -r services/transcription-relay/requirements-dev.txt
PYTHONPATH=services/transcription-relay pytest -q services/transcription-relay/tests
```

## 初始化 Supabase

迁移必须按 `supabase/migrations` 中文件名的时间顺序执行：

1. `supabase/migrations/202608220001_meeting_catalog.sql`
2. `supabase/migrations/202608230002_meeting_notes.sql`
3. `supabase/migrations/202608240001_meeting_audio.sql`
4. `supabase/migrations/202608240002_audio_cleanup.sql`
5. `supabase/migrations/202608240003_meeting_intelligence.sql`
6. `supabase/migrations/202608240004_split_ai_provider_credentials.sql`
7. `supabase/migrations/202608250001_realtime_asr_config.sql`
8. `supabase/migrations/202608250002_public_realtime_asr_endpoint.sql`

推荐使用 Supabase CLI 应用迁移：

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
```

也可以在 Supabase Dashboard 的 SQL Editor 中完整执行该迁移文件。不要只复制其中一部分；表、RLS 策略、权限和 mutation RPC 必须一起建立。

部署前必须通过两层数据库门禁。轻量合同检查不需要 Docker：

```bash
node --test test/supabase-schema.test.mjs
```

有 Docker 时可在本地执行完整 pgTAP：

```bash
npx supabase start
npx supabase db reset
npx supabase test db
```

没有 Docker 时，连接远端测试项目并在事务中执行 pgTAP 文件；测试会在末尾回滚，不保留测试数据：

```bash
npx supabase test db --linked
# 若当前 CLI 仍错误要求 Docker：
npx supabase db query --linked --file supabase/tests/meeting_audio.sql
npx supabase db query --linked --file supabase/tests/audio_cleanup.sql
```

只有目录、笔记、录音和清理测试全部通过后才继续发布。Node 合同检查不能代替真实数据库中的 RLS、权限和保留规则检查。

## 部署录音清理

部署私有清理函数：

```bash
npx supabase functions deploy cleanup-expired-audio
```

在 Supabase Dashboard 中启用 Cron、`pg_net` 和 Vault。将项目的服务端 secret key 存入 Vault，并创建每 15 分钟调用一次 `cleanup-expired-audio` 的 Edge Function 任务。函数关闭旧版网关 JWT 校验，但会在函数内部逐字比对平台注入的服务端密钥；无密钥或错误密钥必须返回 `401`。服务端 secret key 不得进入 GitHub、前端环境变量、浏览器包、文档或 Cron 命令正文。

## 部署实时转写中继

仓库根目录的 `render.yaml` 会从 `services/transcription-relay/Dockerfile` 部署 Python 服务。Render 中按蓝图提示设置 Supabase 地址、公开 anon key、服务端密钥和允许的网页来源；网页来源填 GitHub Pages 的来源，例如 `https://jinlonchen.github.io`，不要包含路径。

中继使用阿里官方 Python SDK 和公共实时接口，不保存音频。部署完成后先确认 `https://中继域名/health` 返回 `{"status":"ok"}`，再把该 HTTPS 根地址写入 GitHub 的 `VITE_TRANSCRIPTION_RELAY_URL` Repository variable。

## 创建并确认邮箱用户

1. 打开 Supabase Dashboard 的 Authentication > Users。
2. 创建自己的邮箱用户，并设置自己的密码。
3. 完成确认邮件，或在创建时使用 Dashboard 的确认选项；回到用户列表确认该邮箱用户已经是 confirmed 状态。
4. 确认可以登录后，在 Authentication 的设置中关闭“允许新用户注册”。

应用没有注册入口。不要把登录密码写进 `apps/web/.env.local`、GitHub Secrets、代码、文档或终端命令。

## 发布到 GitHub Pages

使用公开 GitHub 仓库时，Pages 和 Actions 可以按免费方案运行。

1. 将代码推送到 GitHub 仓库的 `main` 分支。
2. 打开仓库 Settings > Secrets and variables > Actions，创建以下两个 Repository secrets：

   - `VITE_SUPABASE_URL`：Supabase Project URL。
   - `VITE_SUPABASE_ANON_KEY`：Supabase 公开 anon key。

   再创建一个 Repository variable：

   - `VITE_TRANSCRIPTION_RELAY_URL`：Render 中继的公开 HTTPS 根地址。

3. 打开 Settings > Pages，将 Build and deployment 的 Source 设为 `GitHub Actions`。
4. 打开 Actions，等待 `CI` 与 `Deploy GitHub Pages` 均成功。Pages 工作流会先独立完成类型检查、全部测试、数据库合同、生产构建、产物扫描和完整浏览器验收；只有这些门禁全部成功，部署 job 才会使用公开配置重新构建、扫描并上传。工作流会自动把 `VITE_BASE_PATH` 设置为仓库名对应的子路径。
5. 在 Supabase Authentication 的 URL Configuration 中，将 GitHub Pages 的 HTTPS 地址加入允许的 Site URL/Redirect URLs。

静态构建只允许使用上面三个公开浏览器变量。数据库管理凭据、用户密码以及 AI 服务密钥都不能进入 GitHub、前端环境变量或浏览器包。

## 安装到 iPad mini 6

1. 在 iPad 的 Safari 中打开 GitHub Pages 的 HTTPS 地址并登录。
2. 点击 Safari 的“分享”按钮，选择“添加到主屏幕”，名称可保留为“会议本”。
3. 回到主屏幕，从新图标启动应用，确认它以独立窗口打开。
4. 联网时创建一个分类和一个测试会议，等待顶部显示“已同步”。
5. 关闭 Wi-Fi，保持应用打开或从主屏幕重新打开；修改会议名称，确认显示“离线，1 项待同步”。
6. 重新开启 Wi-Fi，等待顶部恢复为“已同步”。再用电脑登录同一账号，确认修改后的名称已经出现。

首次安装和首次登录必须联网。离线可用依赖浏览器已缓存应用，清理 Safari 网站数据会清除本地会议目录和待同步修改。

## 数据保留规则

原始录音在云端和 iPad 本地统一只保留 48 小时，然后自动删除。若 48 小时到期时 PWA 已关闭，本地清理会在下次启动时补做；服务端每 15 分钟独立清理一次，不依赖 PWA 是否打开。

会议笔记、完整转写和 AI 总结永久保存，除非使用者主动删除。断网时录音仍会保存，但实时转写暂停，恢复联网后只继续转写新的音频。
