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

if (!APP_ID || !APP_SECRET) {
  console.error('❌ 错误: 未检测到 FEISHU_APP_ID 或 FEISHU_APP_SECRET，请在 .env 文件中配置！');
  process.exit(1);
}

const client = new lark.Client({ appId: APP_ID, appSecret: APP_SECRET });
const wsClient = new lark.WSClient({ appId: APP_ID, appSecret: APP_SECRET, loggerLevel: lark.LoggerLevel.info });

// 1. 会话读写
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
      content: `当前共有 **${sessions.length}** 个历史主题。\n点击 **[切换]** 可无缝切回，点击 **[🗑️]** 会弹出二次确认防误触。`
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
                    title: { tag: 'plain_text', content: '确认删除当前主题？' },
                    text: { tag: 'plain_text', content: `确定要彻底删除「${title}」吗？\n删除后历史上下文将从列表中移除。` }
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
                    title: { tag: 'plain_text', content: '确认删除该主题？' },
                    text: { tag: 'plain_text', content: `确定要彻底删除「${title}」吗？\n删除后历史上下文将从列表中移除。` }
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

  return res;
}

// 3. 构建任务进度/结果卡片
function buildCard(title, template, prompt, statusList, resultText = '', topicTitle = '') {
  const promptDisplay = prompt.length > 100 ? prompt.slice(0, 100) + '...' : prompt;
  const elements = [
    {
      tag: 'markdown',
      content: `${topicTitle ? `🏷️ **当前主题**：\`${topicTitle}\`\n\n` : ''}**📋 本轮指令**：\n> ${promptDisplay.replace(/\n/g, '\n> ')}`
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
    const displayContent = formatted.length > 4000 
      ? formatted.slice(0, 4000) + '\n\n*(内容较长已在手机端适度截断)*'
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

// 4. 执行 Agent 任务
async function handleAgentExecution(chatId, prompt, workDir = '/root') {
  console.log(`[Task Started] prompt: "${prompt}" in ${workDir}`);

  const sessionsData = loadSessions();
  const isResuming = !!sessionsData.activeSessionId;
  const activeId = sessionsData.activeSessionId;
  
  let currentSession = sessionsData.sessions.find(s => s.id === activeId);
  let topicTitle = currentSession ? currentSession.title : prompt.slice(0, 25);

  const statusList = [
    isResuming 
      ? `🔄 正在接续历史主题【${topicTitle}】并检索上下文...`
      : '🚀 正在开辟全新主题，启动 Antigravity 核心引擎...'
  ];
  let finalResponse = '';

  let initialCard = buildCard(
    isResuming ? `🟡 [接续] ${topicTitle}` : '🟡 [新主题] 正在准备...',
    'yellow',
    prompt,
    statusList,
    '',
    topicTitle
  );

  let msgRes;
  try {
    msgRes = await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(initialCard)
      }
    });
  } catch (e) {
    console.error('发送初始卡片失败:', e);
    return;
  }

  const messageId = msgRes.data?.message_id;
  if (!messageId) return;

  let lastPatchTime = 0;
  const throttledUpdate = async (immediate = false) => {
    const now = Date.now();
    if (immediate || now - lastPatchTime > 1200) {
      lastPatchTime = now;
      const card = buildCard(
        `🟡 [${topicTitle}] 执行中...`,
        'yellow',
        prompt,
        statusList,
        finalResponse,
        topicTitle
      );
      await patchCard(messageId, card);
    }
  };

  const agyArgs = [];
  if (isResuming) {
    agyArgs.push('--conversation', activeId);
  }
  agyArgs.push('-p', prompt, '--output-format', 'stream-json', '--dangerously-skip-permissions');

  const child = spawn(AGY_BIN, agyArgs, {
    cwd: workDir,
    env: { ...process.env, TERM: 'xterm-256color', HOME: '/root' }
  });

  const rl = readline.createInterface({ input: child.stdout });
  let detectedConversationId = null;

  rl.on('line', (line) => {
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

  child.on('close', async (code) => {
    console.log(`[Task Finished] code: ${code}, conversationId: ${detectedConversationId}`);
    statusList.push(code === 0 ? '🏁 任务处理完成！' : `⚠️ 异常退出码: ${code}`);

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
          title: prompt.slice(0, 30),
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
      prompt,
      statusList,
      finalResponse || (code === 0 ? '任务已执行，无额外文本回复。' : '执行遇到异常，请检查配置。'),
      topicTitle
    );

    await patchCard(messageId, finalCard);
  });
}

// 5. 消息路由器
const eventDispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => {
    try {
      const message = data.message;
      if (message.message_type !== 'text') return;

      const content = JSON.parse(message.content);
      const rawText = content.text?.trim() || '';
      const chatId = message.chat_id;

      if (!rawText) return;

      console.log(`[Message Received] "${rawText}" from ${chatId}`);

      // 1. 开启新主题 /new 或 /clear
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

      // 2. 查看历史主题列表 /list
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

      // 3. 删除主题 /del 2 或 /delete 2
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

          await client.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'interactive',
              content: JSON.stringify({
                config: { wide_screen_mode: true },
                header: { template: 'red', title: { tag: 'plain_text', content: '🗑️ 主题删除成功' } },
                elements: [
                  {
                    tag: 'markdown',
                    content: `已成功删除主题：**「${deleted.title}」**\n发送 \`/list\` 可查看更新后的列表。`
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

      // 4. 序号切换 /switch 1 或 /switch 2
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

      // 5. 当前主题 /current
      if (['/current', '/status', '当前', '当前主题'].includes(rawText.toLowerCase())) {
        const sessionsData = loadSessions();
        const active = sessionsData.sessions.find(s => s.id === sessionsData.activeSessionId);
        const title = active ? active.title : '未绑定特定主题（发送首条指令将自动建新主题）';
        await client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text: `📌 当前活跃主题:【${title}】\n发送 /list 可管理所有主题，发送 /new 可开启新主题。` })
          }
        });
        return;
      }

      // 6. 帮助 /help
      if (['/help', '帮助', '菜单'].includes(rawText.toLowerCase())) {
        await client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ 
              text: `🤖 飞书 Agent 指令指南：\n\n` +
                    `• /list   : 查看全部历史主题，点击切换或删除\n` +
                    `• /switch <序号> : 切换到指定主题 (如 /switch 2)\n` +
                    `• /del <序号>    : 删除指定历史主题 (如 /del 3)\n` +
                    `• /new    : 开启全新主题，清空上下文\n` +
                    `• /current: 查看当前所在主题\n` +
                    `• 直接发文字 : 默认在当前主题下多轮连续对话`
            })
          }
        });
        return;
      }

      // 默认指令执行
      handleAgentExecution(chatId, rawText);
    } catch (err) {
      console.error('处理消息失败:', err);
    }
  },

  // 卡片点击事件监听（包含二次确认后的删除回调）
  'card.action.trigger': async (data) => {
    try {
      const action = data.action;
      const value = action?.value;
      const msgId = data.context?.open_message_id || data.open_message_id || data.message_id;
      console.log('[Card Action Triggered]', value, 'detected msgId:', msgId);

      const sessionsData = loadSessions();
      let toastMsg = '操作完成';

      if (value?.action === 'switch_session') {
        const target = sessionsData.sessions.find(s => s.id === value.sessionId);
        if (target) {
          sessionsData.activeSessionId = target.id;
          target.updatedAt = Date.now();
          saveSessions(sessionsData);
          toastMsg = `已切换到：「${target.title.slice(0, 10)}」`;
        }
      } else if (value?.action === 'delete_session') {
        const targetIdx = sessionsData.sessions.findIndex(s => s.id === value.sessionId);
        if (targetIdx !== -1) {
          const deleted = sessionsData.sessions.splice(targetIdx, 1)[0];
          if (sessionsData.activeSessionId === value.sessionId) {
            sessionsData.activeSessionId = sessionsData.sessions[0]?.id || null;
          }
          saveSessions(sessionsData);
          toastMsg = `已删除：「${deleted.title.slice(0, 10)}」`;
        }
      } else if (value?.action === 'new_session') {
        sessionsData.activeSessionId = null;
        saveSessions(sessionsData);
        toastMsg = '已就绪，下条指令建新主题';
      }

      // 1. 显式主动 Patch 卡片，彻底更新卡片界面
      const updatedCard = buildSessionListCard(sessionsData);
      if (msgId) {
        await patchCard(msgId, updatedCard);
      }

      // 2. 返回飞书标准回调 ACK
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

console.log('🚀 正在启动支持【原生二次确认删除】的飞书 Agent 机器人服务...');
wsClient.start({ eventDispatcher });