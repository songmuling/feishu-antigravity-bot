# Feishu Antigravity Bot

基于飞书（Lark）交互式卡片与长连接协议的 Google Antigravity CLI 移动端智能体网关。

随时随地通过手机飞书私聊，直接调度云端部署的 Antigravity Agent 进行多机运维、代码开发与故障排查。

---

## 🌟 核心特性

- **零公网依赖（WebSocket 长连接）**：
  采用客户端直连飞书网关（WSS），服务器无需公网 IP、免开放入站端口、免配置域名与 SSL 证书。
- **动态卡片流式刷新（In-place Patch）**：
  单条消息卡片原地打补丁更新，实时展示 Agent 的思考与 Tool 执行轨迹。
- **多主题多轮会话管理**：
  支持随时开辟新话题或回溯历史上下文，支持会话列表切换与删除防误触确认。
- **移动端 Markdown 智能适配**：
  自动适配飞书卡片语法，优化标题与表格展示，并保护代码块与行内命令。
- **系统级常驻守护**：
  提供 Systemd 服务模板，支持开机自启与异常自愈。

---

## 🚀 快速上手

### 1. 前置准备
- 一台 Linux 服务器（Ubuntu / Debian 等）
- 已安装 Node.js (v18+) 与 Google Antigravity CLI (`agy`)
- 飞书开放平台应用（获取 `App ID` 与 `App Secret`，并在事件订阅中开启“使用长连接接收事件”）

### 2. 安装与配置

```bash
git clone https://github.com/songmuling/feishu-antigravity-bot.git
cd feishu-antigravity-bot
npm install
cp .env.example .env
```

编辑 `.env` 文件填入飞书凭据：
```env
FEISHU_APP_ID=cli_xxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 3. 运行服务

```bash
# 直接测试启动
npm start

# 或配置为系统后台守护服务
sudo cp feishu-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now feishu-agent
```

---

## 💬 交互指令

在飞书私聊窗口直接发送以下指令即可交互：

| 指令 | 说明 |
| :--- | :--- |
| `直接输入需求` | 在当前活跃主题下执行多轮交互 |
| `/list` | 查看所有历史主题，点击可快捷切换或删除 |
| `/switch <序号>` | 切换到指定编号的历史主题 |
| `/del <序号>` | 删除指定主题记录 |
| `/new` | 清空当前会话挂载，开启全新主题 |
| `/current` | 查看当前正在交互的主题名称 |
| `/help` | 查看帮助菜单 |

---

## 📄 开源许可

本项目采用 [MIT License](LICENSE) 授权。
