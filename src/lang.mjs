/**
 * 这个进程对外说哪种语言。
 *
 * 规则与 watch / dashboard 相同：DSH_MCP_LANG 优先，否则跟系统语言走（以 zh 开头 → 中文，其余 → 英文）。
 * 进程启动时定一次。管的是给调用方看的文字 —— 工具清单、服务说明、工具返回的正文；
 * 结构化输出的字段名、日志、落盘文件的格式都不随语言变。
 *
 * 两种语言的文字写在同一处：`L('中文', 'English')`。翻译和原文挨着，改一边时另一边就在眼前。
 */

import { detectLang } from './live-view.mjs';

export const LANG = detectLang();

/** 按当前语言取一段文字。 */
export const L = (zh, en) => (LANG === 'en' ? en : zh);
