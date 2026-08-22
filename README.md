# iPad 会议本

这是面向个人使用的 iPad 会议本 PWA。当前版本提供邮箱密码登录、会议与分类目录、本地离线修改、联网自动同步和安装到 iPad 主屏幕。

当前阶段不包含或实现录音、转写、AI 总结、手写和会议正文编辑。会议详情页目前只是占位页；不要把目录中的“录音中”等状态理解为录音功能已经可用。

## 本地运行

需要 Node.js 22.12 或更高版本，以及一个独立的 Supabase 项目。

1. 安装依赖并创建本地配置：

   ```bash
   npm ci
   cp .env.example apps/web/.env.local
   ```

2. 在 `apps/web/.env.local` 中填写 Supabase 项目设置里显示的 Project URL 和公开 anon key。本地开发的 `VITE_BASE_PATH` 保持 `/`。这些值会进入浏览器构建，只能填写 Supabase 明确标为浏览器可公开使用的值。

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
```

## 初始化 Supabase

迁移必须按 `supabase/migrations` 中文件名的时间顺序执行。目前只有第一项：

1. `supabase/migrations/202608220001_meeting_catalog.sql`

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

真实 pgTAP 检查需要 Docker 和本地 Supabase 服务：

```bash
npx supabase start
npx supabase db reset
npx supabase test db
```

只有 `supabase/tests/meeting_catalog.sql` 全部通过后才继续发布。若本机不能运行 Docker，必须在能够运行 Supabase CLI 的环境完成这项真实 pgTAP 门禁，不能用 Node 合同检查代替它。

## 创建并确认邮箱用户

1. 打开 Supabase Dashboard 的 Authentication > Users。
2. 创建自己的邮箱用户，并设置自己的密码。
3. 完成确认邮件，或在创建时使用 Dashboard 的确认选项；回到用户列表确认该邮箱用户已经是 confirmed 状态。
4. 确认可以登录后，在 Authentication 的设置中关闭“允许新用户注册”。

应用没有注册入口。不要把登录密码写进 `apps/web/.env.local`、GitHub Secrets、代码、文档或终端命令。

## 发布到 GitHub Pages

使用公开 GitHub 仓库时，Pages 和 Actions 可以按免费方案运行。

1. 将代码推送到 GitHub 仓库的 `main` 分支。
2. 打开仓库 Settings > Secrets and variables > Actions，创建且只创建以下两个 Repository secrets：

   - `VITE_SUPABASE_URL`：Supabase Project URL。
   - `VITE_SUPABASE_ANON_KEY`：Supabase 公开 anon key。

3. 打开 Settings > Pages，将 Build and deployment 的 Source 设为 `GitHub Actions`。
4. 打开 Actions，等待 `CI` 与 `Deploy GitHub Pages` 均成功。部署工作流会自动把 `VITE_BASE_PATH` 设置为仓库名对应的子路径。
5. 在 Supabase Authentication 的 URL Configuration 中，将 GitHub Pages 的 HTTPS 地址加入允许的 Site URL/Redirect URLs。

静态构建只允许使用上面两个公开浏览器变量。数据库管理凭据、用户密码以及未来的 AI 服务凭据都不能进入 GitHub、前端环境变量或浏览器包。

## 安装到 iPad mini 6

1. 在 iPad 的 Safari 中打开 GitHub Pages 的 HTTPS 地址并登录。
2. 点击 Safari 的“分享”按钮，选择“添加到主屏幕”，名称可保留为“会议本”。
3. 回到主屏幕，从新图标启动应用，确认它以独立窗口打开。
4. 联网时创建一个分类和一个测试会议，等待顶部显示“已同步”。
5. 关闭 Wi-Fi，保持应用打开或从主屏幕重新打开；修改会议名称，确认显示“离线，1 项待同步”。
6. 重新开启 Wi-Fi，等待顶部恢复为“已同步”。再用电脑登录同一账号，确认修改后的名称已经出现。

首次安装和首次登录必须联网。离线可用依赖浏览器已缓存应用，清理 Safari 网站数据会清除本地会议目录和待同步修改。

## 已确认的后续数据规则

后续实现录音后，原始录音在云端和 iPad 本地统一只保留 48 小时，然后自动删除。若 48 小时到期时 PWA 已关闭，本地清理会在下次启动时补做；服务端清理不能依赖 PWA 是否打开。

会议笔记、完整转写和 AI 总结将永久保存，除非使用者主动删除。以上是后续阶段的数据保留目标，当前版本尚未实现录音、转写、AI 总结或这些内容的永久存储。
