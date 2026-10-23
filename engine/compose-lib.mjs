/**
 * compose-lib.mjs —— 评论 / 回复 / 私信草稿的共用生成逻辑
 * （compose.mjs 是它的命令行外壳；自动评论/自动回复也直接 import 这里）
 */
import { chat, assertKey } from '../../bili-op/llm.mjs'

export const LIMITS = { comment: 40, reply: 40, dm: 120 }

export async function composeText(kind, ctx = {}, persona = '') {
  const k = ['comment', 'reply', 'dm'].includes(kind) ? kind : 'comment'
  const p = String(persona || '').trim()
  const system = `你是 B站 账号的主人，用第一人称写一条${k === 'comment' ? '视频评论' : k === 'reply' ? '评论回复' : '私信'}。
要求：
- 说人话，像真人随手打的，不要客服腔、不要「感谢分享」这种套话
- 不超过 ${LIMITS[k]} 个汉字
- 只输出正文，不要引号、不要解释
${p ? `- 你的人设 / 口径：${p}` : ''}`

  const user = k === 'comment'
    ? `视频：${ctx.title || ''}\nUP：${ctx.up || ''}\n可用金句：${(ctx.quotes || []).slice(0, 3).join('；') || '（无）'}\n`
      + `${(ctx.memes || []).length ? `热梗：${(ctx.memes || []).slice(0, 3).join('；')}\n` : ''}`
      + `${(ctx.hotComments || []).length ? `热评：${(ctx.hotComments || []).slice(0, 3).join('；')}\n` : ''}`
      + '请写一条像看过视频的短评论。'
    : `对方说：${ctx.message || ''}\n${ctx.replyingTo ? `（他回复的是：${ctx.replyingTo}）\n` : ''}${ctx.video ? `视频：${ctx.video}\n` : ''}请写一条自然的回复。`

  assertKey()
  const { text, model } = await chat([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], { maxTokens: 500, temperature: 0.75 })
  const clean = String(text || '').trim()
    .replace(/^["'“”「」]+|["'“”「」]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, LIMITS[k] + 10)
  return { text: clean, model }
}
