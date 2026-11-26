import * as lark from '@larksuiteoapi/node-sdk';
import { spawn } from 'child_process';
import readline from 'readline';
import fs from 'fs';
import path from 'path';

// 环境变量加载 (优先读取当前目录 .env)
const envFile = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile);
}

const APP_ID = process.env.FEISHU_APP_ID || '';
const APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const SESSIONS_FILE = process.env.SESSIONS_FILE || path.resolve(process.cwd(), 'sessions.json');
const AGY_BIN = process.env.AGY_BIN || '/root/.gemini/bin/agy';
const TMP_DIR = process.env.TMP_DIR || path.resolve(process.env.HOME || '/root', 'feishu-agent/tmp');
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

if (!APP_ID || !APP_SECRET) {
  console.error('❌ 错误: 未检测到 FEISHU_APP_ID 或 FEISHU_APP_SECRET，请在 .env 文件中配置！');
  process.exit(1);
}

const client = new lark.Client({ appId: APP_ID, appSecret: APP_SECRET });
const wsClient = new lark.WSClient({ appId: APP_ID, appSecret: APP_SECRET, loggerLevel: lark.LoggerLevel.info });

// 全局任务运行状态与排队队列
let currentTask = null; 
// 结构: { id, child, prompt, chatId, messageId, topicTitle, statusList, isInterrupted, startedAt }

const taskQueue = []; 
// 结构: [{ id, prompt, chatId, messageId, workDir, createdAt }]

const queuePromptMap = new Map(); // 永久保存 queueId -> prompt 映射，防止多次点击导致文本丢失

// 1. 会话读写与磁盘清理
function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('读取 sessions.json 失败:', e);
  }
  return { activeSessionId: null, sessions: [] };
}

function saveSessions(data) {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error('保存 sessions.json 失败:', e);
  }
}

// 物理彻底删除 Antigravity 在磁盘上的会话数据库与日志快照
function purgeAntigravitySession(sessionId) {
  if (!sessionId) return;
  const base = '/root/.gemini/antigravity-cli';
  const paths = [
    path.join(base, 'conversations', `${sessionId}.db`),
    path.join(base, 'brain', sessionId),
    path.join(base, 'presence', `${sessionId}.lock`)
  ];
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
        console.log(`[Purged session on disk] ${p}`);
      }
    } catch (e) {
      console.error(`清理磁盘会话文件失败 ${p}:`, e.message);
    }
  }
}

function timeAgo(date) {
  const seconds = Math.floor((Date.now() - date) / 1000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  return `${Math.floor(hours / 24)}天前`;
}

// 2. 构建会话列表卡片 (包含切换与二次确认删除按钮)
function buildSessionListCard(sessionsData) {
  const { activeSessionId, sessions } = sessionsData;
  const elements = [
    {
      tag: 'markdown',
      content: `当前共有 **${sessions.length}** 个历史主题。\n点击 **[切换]** 可无缝切回，点击 **[🗑️]** 会弹出二次确认彻底删除。`
    },
    { tag: 'hr' }
  ];

  if (sessions.length === 0) {
    elements.push({
      tag: 'markdown',
      content: '*暂无历史主题，发送任意指令即可开启新主题！*'
    });
  } else {
    sessions.forEach((s, idx) => {
      const isCurrent = s.id === activeSessionId;
      const num = idx + 1;
      const title = s.title.length > 25 ? s.title.slice(0, 25) + '...' : s.title;

      if (isCurrent) {
        elements.push({
          tag: 'column_set',
          flex_mode: 'none',
          background_style: 'default',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 4,
              elements: [
                {
                  tag: 'markdown',
                  content: `**📌 [当前活跃] ${num}. ${title}**\n*活跃于 ${timeAgo(s.updatedAt)} · 已交互 ${s.turnCount || 1} 轮*`
                }
              ]
            },
            {
              tag: 'column',
              width: 'auto',
              elements: [
                {
                  tag: 'button',
                  text: { tag: 'plain_text', content: '🗑️' },
                  type: 'danger',
                  confirm: {
                    title: { tag: 'plain_text', content: '确认彻底删除当前主题？' },
                    text: { tag: 'plain_text', content: `确定要彻底删除「${title}」吗？\n删除后历史上下文与底层数据将一并物理清除。` }
                  },
                  value: { action: 'delete_session', sessionId: s.id }
                }
              ]
            }
          ]
        });
      } else {
        elements.push({
          tag: 'column_set',
          flex_mode: 'none',
          background_style: 'grey',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 4,
              elements: [
                {
                  tag: 'markdown',
                  content: `**${num}. ${title}**\n*更新于 ${timeAgo(s.updatedAt)} · ${s.turnCount || 1} 轮交互*`
                }
              ]
            },
            {
              tag: 'column',
              width: 'auto',
              elements: [
                {
                  tag: 'button',
                  text: { tag: 'plain_text', content: '切换' },
                  type: 'primary',
                  value: { action: 'switch_session', sessionId: s.id }
                }
              ]
            },
            {
              tag: 'column',
              width: 'auto',
              elements: [
                {
                  tag: 'button',
                  text: { tag: 'plain_text', content: '🗑️' },
                  type: 'danger',
                  confirm: {
                    title: { tag: 'plain_text', content: '确认彻底删除该主题？' },
                    text: { tag: 'plain_text', content: `确定要彻底删除「${title}」吗？\n删除后历史上下文与底层数据将一并物理清除。` }
                  },
                  value: { action: 'delete_session', sessionId: s.id }
                }
              ]
            }
          ]
        });
      }
    });
  }

  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '➕ 开启全新主题 (/new)' },
        type: 'default',
        value: { action: 'new_session' }
      }
    ]
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '📂 会话历史与主题管理' }
    },
    elements
  };
}

// 3. 表格与标题适配函数：将标准 GFM Markdown 转换为飞书卡片最优展示格式
function convertTablesToReadableLists(markdown) {
  if (!markdown || !markdown.includes('|')) return markdown;
  const lines = markdown.split('\n');
  const output = [];
  let inTable = false;
  let headers = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('|') && line.endsWith('|')) {
      const cells = line.split('|').slice(1, -1).map(c => c.trim());
      if (cells.every(c => /^:?-+:?$/.test(c))) {
        inTable = true;
        continue;
      }

      if (!inTable) {
        const nextLine = lines[i + 1]?.trim();
        if (nextLine && nextLine.startsWith('|') && nextLine.endsWith('|')) {
          const nextCells = nextLine.split('|').slice(1, -1).map(c => c.trim());
          if (nextCells.every(c => /^:?-+:?$/.test(c))) {
            headers = cells;
            continue;
          }
        }
      }

      if (inTable && headers.length > 0) {
        const rowParts = [];
        cells.forEach((val, colIdx) => {
          if (val) {
            const headerName = headers[colIdx] || ('列' + (colIdx + 1));
            rowParts.push(`${headerName}: \`${val}\``);
          }
        });
        output.push(`• ${rowParts.join(' ｜ ')}`);
        continue;
      }
    } else {
      inTable = false;
      headers = [];
    }
    output.push(lines[i]);
  }
  return output.join('\n');
}

function formatForFeishu(text) {
  if (!text) return '';
  // 1. 提取保护代码块 (```代码块``` 和 `行内代码`)，防止代码中的 # 注释或管道符 | 被误改
  const codeBlocks = [];
  let res = text.replace(/(```[\s\S]*?```|`[^`\n]+`)/g, (match) => {
    const placeholder = `___CODE_BLOCK_${codeBlocks.length}___`;
    codeBlocks.push(match);
    return placeholder;
  });

  // 2. 标题层级静默转换为飞书原生支持的高亮粗体 + 视觉图标
  res = res.replace(/^(\s*)#\s+(.+)$/gm, '$1📌 **$2**');
  res = res.replace(/^(\s*)##\s+(.+)$/gm, '$1🔹 **$2**');
  res = res.replace(/^(\s*)#{3,6}\s*(.+)$/gm, '$1▪️ **$2**');

  // 3. 表格静默转换为移动端清晰清单
  res = convertTablesToReadableLists(res);

  // 4. 完美还原代码块
  codeBlocks.forEach((code, idx) => {
    res = res.replace(`___CODE_BLOCK_${idx}___`, () => code);
  });

  // 5. 将非 http/https 协议链接（如 [index.html](ssh://KR)）还原为可读文本，避免飞书客户端协议校验异常
  res = res.replace(/\[([^\]]+)\]\((?!(?:https?:\/\/))([^)]+)\)/g, '$1 ($2)');

  // 6. 替换 HTML/XML 标签中的 < 与 > 为全角 ＜ 与 ＞，防止飞书手机端将其误判为原生富文本节点导致 AST 错位与内容丢失
  res = res.replace(/<(?!at\s|\/at>|https?:\/\/|http:\/\/)(\/?[a-zA-Z!][^>\n]*?)>/g, '＜$1＞');

  return res;
}

// 4. 构建任务进度/结果卡片
const CARD_TEXT_LIMIT = 25000; // 飞书单卡片安全容量上限（实测支持至 25000~30000 字符）

function formatPromptCodeBlock(text, maxLength = 300) {
  if (!text) return '```text\n(空)\n```';
  let cleanText = text;
  if (cleanText.length > maxLength) {
    cleanText = cleanText.slice(0, maxLength) + '...';
  }
  cleanText = cleanText.replace(/```/g, '` ` `');
  return `\`\`\`text\n${cleanText}\n\`\`\``;
}

function buildCard(title, template, prompt, statusList, resultText = '', topicTitle = '') {
  const promptCodeBlock = formatPromptCodeBlock(prompt, 300);
  const elements = [
    {
      tag: 'markdown',
      content: `${topicTitle ? `🏷️ **当前主题**：\`${topicTitle}\`\n\n` : ''}**📋 本轮指令**：\n${promptCodeBlock}`
    },
    { tag: 'hr' }
  ];

  if (statusList && statusList.length > 0) {
    elements.push({
      tag: 'markdown',
      content: `**⚙️ 执行轨迹**：\n${statusList.slice(-6).join('\n')}`
    });
  }

  if (resultText) {
    elements.push({ tag: 'hr' });
    const formatted = formatForFeishu(resultText);
    const displayContent = formatted.length > CARD_TEXT_LIMIT 
      ? formatted.slice(0, CARD_TEXT_LIMIT) + '\n\n*(内容极长已达单张卡片上限，超长部分已自动续发后续卡片)*'
      : formatted;
    elements.push({
      tag: 'markdown',
      content: `**💬 执行结果与回复**：\n\n${displayContent}`
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      template: template,
      title: { tag: 'plain_text', content: title }
    },
    elements: elements
  };
}

// 构建排队卡片 (包含打断插队与取消排队按钮)
function buildQueueCard(runningPrompt, queuedPrompt, queuePos, queueId) {
  const displayRunning = (runningPrompt || '').length > 50 ? (runningPrompt || '').slice(0, 50) + '...' : (runningPrompt || '');
  const safeRunning = displayRunning.replace(/`/g, "'");
  const queuedCodeBlock = formatPromptCodeBlock(queuedPrompt, 200);
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: `⏳ 任务排队中 (队列第 ${queuePos} 位)` }
    },
    elements: [
      {
        tag: 'markdown',
        content: `**📋 你的待办指令**：\n${queuedCodeBlock}\n⚠️ **当前正忙**：正在执行【\`${safeRunning}\`】\n*排队等待中，前序任务结束后将自动开始本任务。*`
      },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '⚡ 立即打断插队' },
            type: 'danger',
            confirm: {
              title: { tag: 'plain_text', content: '确认打断当前任务？' },
              text: { tag: 'plain_text', content: `确定要强制停止当前正在运行的任务，立刻开始执行本条指令吗？` }
            },
            value: { action: 'steer_task', queueId: queueId }
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ 取消排队' },
            type: 'default',
            value: { action: 'cancel_queue', queueId: queueId }
          }
        ]
      }
    ]
  };
}

// 构建取消排队卡片 (原文字备份一键复制区)
function buildCancelCard(promptText) {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'grey',
      title: { tag: 'plain_text', content: '❌ 任务已取消排队' }
    },
    elements: [
      {
        tag: 'markdown',
        content: `**📝 已取消的指令文本**：\n\n\`\`\`text\n${promptText || '未记录到文本'}\n\`\`\`\n\n*💡 提示：在上方聊天记录中长按你自己发出的「文字气泡」点击「撤回」，飞书也会原生自动将文字重新放回输入框；或直接点击下方按钮一键重发。*`
      },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🚀 一键重新执行此指令' },
            type: 'primary',
            value: { action: 'retry_prompt', prompt: promptText }
          }
        ]
      }
    ]
  };
}

async function patchCard(messageId, card) {
  try {
    const res = await client.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) }
    });
    console.log('[patchCard success]', messageId, res.code, res.msg);
  } catch (err) {
    console.error('更新卡片失败:', err.message);
  }
}

// 5. 任务调度执行引擎 (支持排队与打断插队)
// 终止指定任务的底层子进程（严格作用域绑定，避免误杀后续任务）
function terminateTask(taskToKill) {
  if (!taskToKill || !taskToKill.child) return;
  taskToKill.isInterrupted = true;
  const childProc = taskToKill.child;

  let hasExited = false;
  let killTimer = null;
  const cleanup = () => {
    hasExited = true;
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
  };

  childProc.once('close', cleanup);
  childProc.once('exit', cleanup);

  try {
    childProc.kill('SIGTERM');
    killTimer = setTimeout(() => {
      try {
        if (!hasExited) {
          childProc.kill('SIGKILL');
        }
      } catch (_) {}
    }, 1500);
  } catch (e) {
    console.error(`[terminateTask error] ${taskToKill.id}:`, e);
  }
}

// 下载飞书消息内的图片资源并保存到本地
async function downloadMessageImages(messageId, imageKeys, tmpDir) {
  const downloadedPaths = [];
  for (let i = 0; i < imageKeys.length; i++) {
    const key = imageKeys[i];
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '').slice(-16);
    const fileName = `img_${Date.now()}_${i + 1}_${safeKey}.png`;
    const localPath = path.join(tmpDir, fileName);

    try {
      console.log(`[Downloading Image] messageId: ${messageId}, key: ${key} -> ${localPath}`);
      const fileRes = await client.im.v1.messageResource.get({
        path: {
          message_id: messageId,
          file_key: key
        },
        params: {
          type: 'image'
        }
      });
      await fileRes.writeFile(localPath);
      downloadedPaths.push(localPath);
      console.log(`[Image Downloaded] ${localPath}`);
    } catch (err) {
      console.error(`[Download Image Failed] key ${key}:`, err.message || err);
    }
  }
  return downloadedPaths;
}

async function enqueueOrRun(chatId, prompt, workDir = '/root', displayPrompt = null) {
  const textForCard = displayPrompt || prompt;
  if (currentTask) {
    // 当前有正在执行的任务，压入队列并发送排队等待卡片
    const queueId = 'q_' + Date.now();
    queuePromptMap.set(queueId, textForCard);
    const queuePos = taskQueue.length + 1;
    const initialQueueCard = buildQueueCard(currentTask.displayPrompt || currentTask.prompt, textForCard, queuePos, queueId);

    try {
      const msgRes = await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(initialQueueCard)
        }
      });
      const queueMsgId = msgRes.data?.message_id;
      taskQueue.push({
        id: queueId,
        chatId,
        prompt,
        displayPrompt: textForCard,
        messageId: queueMsgId,
        workDir,
        createdAt: Date.now()
      });
      console.log(`[Task Queued] "${textForCard.slice(0, 20)}" pos: ${queuePos}, id: ${queueId}`);
    } catch (e) {
      console.error('发送排队卡片失败:', e);
    }
    return;
  }

  // 没有正在运行的任务，直接启动
  await executeTask({
    id: 't_' + Date.now(),
    chatId,
    prompt,
    displayPrompt: textForCard,
    messageId: null,
    workDir
  });
}

async function executeTask(taskItem) {
  const { chatId, prompt, displayPrompt = prompt, workDir = '/root' } = taskItem;
  let messageId = taskItem.messageId;

  console.log(`[Task Started] prompt: "${displayPrompt.slice(0, 30)}" in ${workDir}`);

  const sessionsData = loadSessions();
  const isResuming = !!sessionsData.activeSessionId;
  const activeId = sessionsData.activeSessionId;
  
  let currentSession = sessionsData.sessions.find(s => s.id === activeId);
  let topicTitle = currentSession ? currentSession.title : displayPrompt.slice(0, 25);

  const statusList = [
    isResuming 
      ? `🔄 正在接续历史主题【${topicTitle}】并检索上下文...`
      : '🚀 正在开辟全新主题，启动 Antigravity 核心引擎...'
  ];
  let finalResponse = '';

  const initialCard = buildCard(
    isResuming ? `🟡 [接续] ${topicTitle}` : '🟡 [新主题] 正在准备...',
    'yellow',
    displayPrompt,
    statusList,
    '',
    topicTitle
  );

  if (messageId) {
    // 如果之前是排队卡片，直接原地将排队卡片 Patch 转换为执行中卡片！
    await patchCard(messageId, initialCard);
  } else {
    // 首次直接触发，创建新卡片
    try {
      const msgRes = await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(initialCard)
        }
      });
      messageId = msgRes.data?.message_id;
    } catch (e) {
      console.error('发送初始卡片失败:', e);
      checkAndRunNext();
      return;
    }
  }

  if (!messageId) {
    checkAndRunNext();
    return;
  }

  const agyArgs = [];
  if (isResuming) {
    agyArgs.push('--conversation', activeId);
  }
  agyArgs.push('-p', prompt, '--output-format', 'stream-json', '--dangerously-skip-permissions');

  const child = spawn(AGY_BIN, agyArgs, {
    cwd: workDir,
    env: { ...process.env, TERM: 'xterm-256color', HOME: '/root' }
  });

  // 记录本任务的专属句柄（闭包隔离，不受外部插队与全局状态替换影响）
  const thisTask = {
    id: taskItem.id,
    child,
    prompt,
    displayPrompt,
    chatId,
    messageId,
    topicTitle,
    statusList,
    isInterrupted: false,
    startedAt: Date.now()
  };
  currentTask = thisTask;

  let lastPatchTime = 0;
  const throttledUpdate = async (immediate = false) => {
    if (thisTask.isInterrupted) return;
    const now = Date.now();
    if (immediate || now - lastPatchTime > 1200) {
      lastPatchTime = now;
      const card = buildCard(
        `🟡 [${topicTitle}] 执行中...`,
        'yellow',
        displayPrompt,
        statusList,
        finalResponse,
        topicTitle
      );
      await patchCard(messageId, card);
    }
  };

  const rl = readline.createInterface({ input: child.stdout });
  let detectedConversationId = null;

  rl.on('line', (line) => {
    if (thisTask.isInterrupted) return;
    line = line.trim();
    if (!line) return;

    try {
      const evt = JSON.parse(line);

      if (evt.event === 'init' && evt.conversation_id) {
        detectedConversationId = evt.conversation_id;
      }

      if (evt.event === 'step_update' && evt.step_update) {
        const step = evt.step_update;
        if (step.step_type === 'tool') {
          const cmd = step.tool_info?.parameters?.CommandLine || step.tool_name || 'tool';
          if (step.state === 'ACTIVE') {
            statusList.push(`🔄 运行命令: \`${cmd.slice(0, 60)}\``);
          } else if (step.state === 'DONE') {
            statusList.push(`✅ 完成命令: \`${cmd.slice(0, 60)}\``);
          }
        } else if (step.step_type === 'agent_response' && step.text_delta) {
          finalResponse += step.text_delta;
        }
      } else if (evt.event === 'result' && evt.result) {
        if (evt.result.response) {
          finalResponse = evt.result.response;
        }
        if (evt.result.conversation_id) {
          detectedConversationId = evt.result.conversation_id;
        }
      }
    } catch (_) {
      if (line.length < 150 && !line.startsWith('{')) {
        statusList.push(`ℹ️ ${line}`);
      }
    }

    throttledUpdate(false);
  });

  child.stderr.on('data', (data) => {
    console.error('stderr:', data.toString());
  });

  child.on('close', async (code, signal) => {
    console.log(`[Task Closed] id: ${thisTask.id}, code: ${code}, signal: ${signal}, conversationId: ${detectedConversationId}`);

    // 如果本任务已被外部打断（例如被插队或/stop），卡片已就绪，直接跳过并清理
    if (thisTask.isInterrupted) {
      console.log(`[Task Interrupted Ignored Close] ${thisTask.id}`);
      if (currentTask === thisTask) {
        currentTask = null;
        checkAndRunNext();
      }
      return;
    }

    // 只有当全局 currentTask 确实指向本任务时才置空，绝不误清除后续任务
    if (currentTask === thisTask) {
      currentTask = null;
    }

    statusList.push(code === 0 ? '🏁 任务处理完成！' : `⚠️ 异常退出码: ${code || signal}`);

    const finalSessionId = detectedConversationId || activeId;
    if (finalSessionId) {
      sessionsData.activeSessionId = finalSessionId;
      let s = sessionsData.sessions.find(x => x.id === finalSessionId);
      if (s) {
        s.updatedAt = Date.now();
        s.turnCount = (s.turnCount || 1) + 1;
      } else {
        sessionsData.sessions.unshift({
          id: finalSessionId,
          title: displayPrompt.slice(0, 30),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          turnCount: 1
        });
      }
      saveSessions(sessionsData);
    }

    const finalCard = buildCard(
      code === 0 ? `🟢 [${topicTitle}] 成功完成` : '❌ 任务执行异常',
      code === 0 ? 'green' : 'red',
      displayPrompt,
      statusList,
      finalResponse || (code === 0 ? '任务已执行，无额外文本回复。' : '执行遇到异常，请检查配置。'),
      topicTitle
    );

    await patchCard(messageId, finalCard);

    // 超过 25,000 字符的超长内容，自动以续发卡片在同一会话中推送，确保 100% 永不丢字！
    const formattedFull = formatForFeishu(finalResponse);
    if (code === 0 && formattedFull.length > CARD_TEXT_LIMIT) {
      let remaining = formattedFull.slice(CARD_TEXT_LIMIT);
      let partIdx = 2;
      while (remaining.length > 0) {
        const chunk = remaining.slice(0, CARD_TEXT_LIMIT);
        remaining = remaining.slice(CARD_TEXT_LIMIT);

        const continuationCard = {
          config: { wide_screen_mode: true },
          header: {
            template: 'blue',
            title: { tag: 'plain_text', content: `📑 [${topicTitle}] (续篇 ${partIdx})` }
          },
          elements: [
            {
              tag: 'markdown',
              content: chunk
            }
          ]
        };

        try {
          await client.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'interactive',
              content: JSON.stringify(continuationCard)
            }
          });
          console.log(`[Continuation Message Sent] Part ${partIdx} for ${thisTask.id}`);
        } catch (err) {
          console.error(`[Continuation Message Failed] Part ${partIdx}:`, err.message);
        }
        partIdx++;
      }
    }

    // 检查并调度队列中的下一个任务
    checkAndRunNext();
  });
}

function checkAndRunNext() {
  if (currentTask) return;
  if (taskQueue.length > 0) {
    const nextTask = taskQueue.shift();
    console.log(`[Queue Dequeued] Starting next task: ${nextTask.prompt.slice(0, 25)}`);
    executeTask(nextTask);
  }
}

// 6. 消息路由器
const eventDispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => {
    try {
      const message = data.message;
      if (!message) return;

      const messageType = message.message_type;
      const messageId = message.message_id;
      const chatId = message.chat_id;

      let rawText = '';
      const imageKeys = [];

      if (messageType === 'text') {
        const content = JSON.parse(message.content);
        rawText = content.text?.trim() || '';
      } else if (messageType === 'image') {
        const content = JSON.parse(message.content);
        if (content.image_key) {
          imageKeys.push(content.image_key);
        }
      } else if (messageType === 'post') {
        const content = JSON.parse(message.content);
        let postObj = content;
        if (content.zh_cn) postObj = content.zh_cn;
        else if (content.en_us) postObj = content.en_us;
        else if (content.ja_jp) postObj = content.ja_jp;
        else {
          const firstLocale = Object.keys(content).find(k => content[k]?.content);
          if (firstLocale) postObj = content[firstLocale];
        }

        const title = postObj?.title?.trim() || '';
        const lines = [];
        if (title) lines.push(title);

        const paragraphs = postObj?.content || [];
        for (const p of paragraphs) {
          if (!Array.isArray(p)) continue;
          let pText = '';
          for (const el of p) {
            if (el.tag === 'text') {
              pText += el.text || '';
            } else if (el.tag === 'a') {
              pText += el.text || el.href || '';
            } else if (el.tag === 'at') {
              pText += `@${el.user_name || '用户'}`;
            } else if (el.tag === 'img' && el.image_key) {
              imageKeys.push(el.image_key);
            }
          }
          if (pText.trim()) {
            lines.push(pText.trim());
          }
        }
        rawText = lines.join('\n').trim();
      } else {
        console.log(`[Ignored Message Type] ${messageType}`);
        return;
      }

      console.log(`[Message Received] type: ${messageType}, text: "${rawText.slice(0, 30)}", images: ${imageKeys.length} from ${chatId}`);

      if (!rawText && imageKeys.length === 0) return;

      // 仅当没有图片且为特定命令时，触发快捷命令路由
      if (imageKeys.length === 0) {
        // 1. 紧急停止 /stop 或 /kill
        if (['/stop', '/kill', '停止', '终止', '取消当前任务'].includes(rawText.toLowerCase())) {
          if (!currentTask && taskQueue.length === 0) {
            await client.im.v1.message.create({
              params: { receive_id_type: 'chat_id' },
              data: {
                receive_id: chatId,
                msg_type: 'text',
                content: JSON.stringify({ text: 'ℹ️ 当前没有正在运行或排队的任务。' })
              }
            });
            return;
          }

          if (currentTask) {
            const taskToStop = currentTask;
            currentTask = null;
            terminateTask(taskToStop);

            await patchCard(
              taskToStop.messageId,
              buildCard('⏹️ [已手动停止] 任务已终止', 'grey', taskToStop.displayPrompt || taskToStop.prompt, [...taskToStop.statusList, '🛑 用户发送了 /stop 终止指令'], '任务已被手动终止。', taskToStop.topicTitle)
            );
          }

          if (taskQueue.length > 0) {
            for (const q of taskQueue) {
              if (q.messageId) {
                await patchCard(q.messageId, buildCancelCard(q.prompt));
              }
            }
            taskQueue.length = 0;
          }

          await client.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'text',
              content: JSON.stringify({ text: `🛑 已强制终止当前任务，并已取消所有排队指令。` })
            }
          });
          return;
        }

        // 2. 开启新主题 /new 或 /clear
        if (['/new', '/clear', '新建', '新建主题', '新建会话', '开启新主题'].includes(rawText.toLowerCase())) {
          const sessionsData = loadSessions();
          sessionsData.activeSessionId = null;
          saveSessions(sessionsData);

          await client.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'interactive',
              content: JSON.stringify({
                config: { wide_screen_mode: true },
                header: { template: 'green', title: { tag: 'plain_text', content: '✨ 已开启全新主题' } },
                elements: [
                  {
                    tag: 'markdown',
                    content: '历史上下文已安全封存。\n\n**你的下一条消息将作为新主题的开端**，随时可以开始下发新任务！'
                  }
                ]
              })
            }
          });
          return;
        }

        // 3. 查看历史主题列表 /list
        if (['/list', '/history', '历史', '会话', '主题', '会话列表', '历史主题'].includes(rawText.toLowerCase())) {
          const sessionsData = loadSessions();
          const card = buildSessionListCard(sessionsData);
          await client.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'interactive',
              content: JSON.stringify(card)
            }
          });
          return;
        }

        // 4. 删除主题 /del 2 或 /delete 2 (支持磁盘物理彻底清理)
        const delMatch = rawText.match(/^\/(?:del|delete|rm)\s*(\d+)$/i) || rawText.match(/^删除\s*(\d+)$/);
        if (delMatch) {
          const targetIdx = parseInt(delMatch[1], 10) - 1;
          const sessionsData = loadSessions();
          if (targetIdx >= 0 && targetIdx < sessionsData.sessions.length) {
            const deleted = sessionsData.sessions.splice(targetIdx, 1)[0];
            if (sessionsData.activeSessionId === deleted.id) {
              sessionsData.activeSessionId = sessionsData.sessions[0]?.id || null;
            }
            saveSessions(sessionsData);
            // 物理彻底清理底层数据库与脑图日志
            purgeAntigravitySession(deleted.id);

            await client.im.v1.message.create({
              params: { receive_id_type: 'chat_id' },
              data: {
                receive_id: chatId,
                msg_type: 'interactive',
                content: JSON.stringify({
                  config: { wide_screen_mode: true },
                  header: { template: 'red', title: { tag: 'plain_text', content: '🗑️ 主题彻底删除成功' } },
                  elements: [
                    {
                      tag: 'markdown',
                      content: `已成功彻底删除主题：**「${deleted.title}」**（底层数据与索引已一并抹除）。\n发送 \`/list\` 可查看更新后的列表。`
                    }
                  ]
                })
              }
            });
            return;
          } else {
            await client.im.v1.message.create({
              params: { receive_id_type: 'chat_id' },
              data: {
                receive_id: chatId,
                msg_type: 'text',
                content: JSON.stringify({ text: `❌ 序号无效，请输入 1 ~ ${sessionsData.sessions.length} 之间的有效序号（发送 /list 查看列表）` })
              }
            });
            return;
          }
        }

        // 5. 序号切换 /switch 1 或 /switch 2
        const switchMatch = rawText.match(/^\/(?:switch|sw|s)\s*(\d+)$/i) || rawText.match(/^切换\s*(\d+)$/);
        if (switchMatch) {
          const targetIdx = parseInt(switchMatch[1], 10) - 1;
          const sessionsData = loadSessions();
          if (targetIdx >= 0 && targetIdx < sessionsData.sessions.length) {
            const target = sessionsData.sessions[targetIdx];
            sessionsData.activeSessionId = target.id;
            target.updatedAt = Date.now();
            saveSessions(sessionsData);

            await client.im.v1.message.create({
              params: { receive_id_type: 'chat_id' },
              data: {
                receive_id: chatId,
                msg_type: 'interactive',
                content: JSON.stringify({
                  config: { wide_screen_mode: true },
                  header: { template: 'blue', title: { tag: 'plain_text', content: '🔀 会话主题切换成功' } },
                  elements: [
                    {
                      tag: 'markdown',
                      content: `已成功切换到主题：**「${target.title}」**\n*当前历史已无缝挂载，你可以直接继续向它追问！*`
                    }
                  ]
                })
              }
            });
            return;
          } else {
            await client.im.v1.message.create({
              params: { receive_id_type: 'chat_id' },
              data: {
                receive_id: chatId,
                msg_type: 'text',
                content: JSON.stringify({ text: `❌ 序号无效，请输入 1 ~ ${sessionsData.sessions.length} 之间的有效序号（发送 /list 查看列表）` })
              }
            });
            return;
          }
        }

        // 6. 当前主题 /current
        if (['/current', '/status', '当前', '当前主题'].includes(rawText.toLowerCase())) {
          const sessionsData = loadSessions();
          const active = sessionsData.sessions.find(s => s.id === sessionsData.activeSessionId);
          const title = active ? active.title : '未绑定特定主题（发送首条指令将自动建新主题）';
          const busyText = currentTask ? ` (⚠️ 正忙: 执行中【${(currentTask.displayPrompt || currentTask.prompt).slice(0, 15)}...】)` : ' (🟢 空闲)';
          await client.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'text',
              content: JSON.stringify({ text: `📌 当前活跃主题:【${title}】${busyText}\n排队任务数: ${taskQueue.length} 个\n发送 /list 可管理所有主题，发送 /new 可开启新主题。` })
            }
          });
          return;
        }

        // 7. 帮助 /help
        if (['/help', '帮助', '菜单'].includes(rawText.toLowerCase())) {
          await client.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'text',
              content: JSON.stringify({ 
                text: `🤖 飞书 Agent 指令指南：\n\n` +
                      `• /list   : 查看全部历史主题，点击切换或彻底删除\n` +
                      `• /switch <序号> : 切换到指定主题 (如 /switch 2)\n` +
                      `• /del <序号>    : 彻底删除指定主题 (连同底层数据)\n` +
                      `• /new    : 开启全新主题，清空上下文\n` +
                      `• /stop   : 紧急终止当前任务并清空排队\n` +
                      `• /current: 查看当前所在主题与运行状态\n` +
                      `• 直接发文字/图片 : 默认执行指令（支持多模态识图，若正忙会自动排队）`
              })
            }
          });
          return;
        }
      }

      // 默认指令执行 (包含下载图片与多模态组装)
      let finalPrompt = rawText;
      let displayPrompt = rawText;

      if (imageKeys.length > 0) {
        const savedPaths = await downloadMessageImages(messageId, imageKeys, TMP_DIR);
        if (savedPaths.length > 0) {
          const imgNotice = savedPaths.map((p, idx) => `【图片 ${idx + 1} 本地路径】: ${p}`).join('\n');
          if (finalPrompt) {
            finalPrompt = `${imgNotice}\n\n用户附带了上述图片并提问：\n${finalPrompt}\n\n请使用 read_file 或相关多模态分析能力查看本地图片，并结合用户的问题进行分析与解答。`;
            displayPrompt = `🖼️ [附图 ${savedPaths.length} 张] ${displayPrompt}`;
          } else {
            finalPrompt = `${imgNotice}\n\n用户上传了上述图片，请使用 read_file 查看并分析该图片的内容，给出详细解析。`;
            displayPrompt = `🖼️ [附图 ${savedPaths.length} 张]`;
          }
        } else if (!finalPrompt) {
          await client.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'text',
              content: JSON.stringify({ text: '⚠️ 图片下载失败，请检查飞书开放平台是否已授予应用「读取消息中的资源文件」权限。' })
            }
          });
          return;
        }
      }

      enqueueOrRun(chatId, finalPrompt, '/root', displayPrompt);
    } catch (err) {
      console.error('处理消息失败:', err);
    }
  },

  // 卡片点击事件监听（包含二次确认后的删除回调、打断插队、取消排队）
  'card.action.trigger': async (data) => {
    try {
      const action = data.action;
      const value = action?.value;
      const msgId = data.context?.open_message_id || data.open_message_id || data.message_id;
      console.log('[Card Action Triggered]', value, 'detected msgId:', msgId);

      const sessionsData = loadSessions();
      let toastMsg = '操作完成';

      // 1. 打断插队
      if (value?.action === 'steer_task') {
        const queueIdx = taskQueue.findIndex(q => q.id === value.queueId);
        if (queueIdx === -1) {
          return { toast: { type: 'warning', content: '该排队任务已开始执行或已取消' } };
        }
        const targetTask = taskQueue.splice(queueIdx, 1)[0];

        // 打断当前正在运行的任务
        if (currentTask) {
          const interruptedTask = currentTask;
          currentTask = null;
          terminateTask(interruptedTask);

          await patchCard(
            interruptedTask.messageId,
            buildCard('⚠️ [已打断] 任务被新指令插队', 'grey', interruptedTask.displayPrompt || interruptedTask.prompt, [...interruptedTask.statusList, '⚡ 用户点击插队，此任务已终止'], '此任务已被新任务插队打断，未执行后续步骤。', interruptedTask.topicTitle)
          );
        }

        // 立即启动这个插队的任务
        executeTask(targetTask);

        const progressCard = buildCard(
          `🟡 [插队执行] 正在启动...`,
          'yellow',
          targetTask.displayPrompt || targetTask.prompt,
          ['⚡ 已打断前序任务，新指令立刻启动！'],
          '',
          (targetTask.displayPrompt || targetTask.prompt).slice(0, 20)
        );

        return {
          toast: {
            type: 'success',
            content: '⚡ 插队成功！已终止前序任务，立刻开始执行！'
          },
          card: {
            type: 'raw',
            data: progressCard
          }
        };
      }

      // 2. 取消排队 (保留文字备份)
      if (value?.action === 'cancel_queue') {
        const queueIdx = taskQueue.findIndex(q => q.id === value.queueId);
        let cancelledPrompt = queuePromptMap.get(value.queueId) || '';
        if (queueIdx !== -1) {
          const removed = taskQueue.splice(queueIdx, 1)[0];
          if (!cancelledPrompt) cancelledPrompt = removed.prompt;
        }

        const cancelCard = buildCancelCard(cancelledPrompt || '已取消的任务');
        if (msgId) {
          await patchCard(msgId, cancelCard);
        }

        // 核心修复：必须在回调 ACK 中显式返回卡片数据，否则飞书客户端会回滚到本地卡片缓存！
        return {
          toast: {
            type: 'info',
            content: '已取消排队，指令文本已在卡片中备份'
          },
          card: {
            type: 'raw',
            data: cancelCard
          }
        };
      }

      // 3. 一键重新执行此指令
      if (value?.action === 'retry_prompt') {
        const retryPrompt = value.prompt;
        const targetChatId = data.open_chat_id || data.context?.open_chat_id;
        if (retryPrompt) {
          enqueueOrRun(targetChatId || data.chat_id, retryPrompt);
        }
        return {
          toast: {
            type: 'success',
            content: '🚀 已重新提交任务！'
          }
        };
      }

      // 3. 切换主题
      if (value?.action === 'switch_session') {
        const target = sessionsData.sessions.find(s => s.id === value.sessionId);
        if (target) {
          sessionsData.activeSessionId = target.id;
          target.updatedAt = Date.now();
          saveSessions(sessionsData);
          toastMsg = `已切换到：「${target.title.slice(0, 10)}」`;
        }
      } 
      // 4. 彻底删除主题 (连同底层物理文件)
      else if (value?.action === 'delete_session') {
        const targetIdx = sessionsData.sessions.findIndex(s => s.id === value.sessionId);
        if (targetIdx !== -1) {
          const deleted = sessionsData.sessions.splice(targetIdx, 1)[0];
          if (sessionsData.activeSessionId === value.sessionId) {
            sessionsData.activeSessionId = sessionsData.sessions[0]?.id || null;
          }
          saveSessions(sessionsData);
          // 物理彻底删除底层数据库与 brain 目录
          purgeAntigravitySession(deleted.id);
          toastMsg = `已彻底删除：「${deleted.title.slice(0, 10)}」`;
        }
      } 
      // 5. 开启新主题
      else if (value?.action === 'new_session') {
        sessionsData.activeSessionId = null;
        saveSessions(sessionsData);
        toastMsg = '已就绪，下条指令建新主题';
      }

      // 显式主动 Patch 更新卡片
      const updatedCard = buildSessionListCard(sessionsData);
      if (msgId) {
        await patchCard(msgId, updatedCard);
      }

      return {
        toast: {
          type: 'success',
          content: toastMsg
        },
        card: {
          type: 'raw',
          data: updatedCard
        }
      };
    } catch (e) {
      console.error('卡片交互处理异常:', e);
      return {
        toast: {
          type: 'danger',
          content: '处理异常，请重试'
        }
      };
    }
  }
});

console.log('🚀 正在启动支持【排队/打断插队/物理彻底删除】的飞书 Agent 机器人服务...');
wsClient.start({ eventDispatcher });
