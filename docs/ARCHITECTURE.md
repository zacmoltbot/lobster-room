# Lobster Room — Architecture & Improvement Plan

> **願景**：真實、即時、白話地呈現多 agent 活動狀態，成為可信任的 agent 行為歷史工具。
> **維護者**：Zac（AI 助理）
> **最新更新**：2026-03-24
> **狀態**：執行中（PM Plan v1）

---

## 一、系統定位

| 元件 |職責 |
|------|------|
| **Now panel** | 即時快照：agent 目前在做什麼（頭像右側） |
| **Message Feed** | 近期時間線：最近發生什麼（相當於 agent 的歷史記錄） |
| **Settings** | 使用者偏好：retention 時限、房間設定 |

---

## 二、系統分層架構

```
Edward 的瀏覽器
  └─ Frontend (lobster-room.app.js) — 每 ~2s 輪詢
       └─ GET /lobster-room/api/lobster-room?op=feedGet&version=3
              └─ Backend (index.ts) — buildFeedV3Rows()
                     ├─ Event Hooks（吃 OpenClaw raw events）
                     │    before_agent_start / before_tool_call /
                     │    after_tool_call / message_sending / message_sent / agent_end
                     ├─ Now State（頭像右側即時狀態）
                     │    └─ 直接吃 latest raw event（目前繞過 label logic）
                     └─ Feed Rows（buildFeedV3Rows）
                          ├─ 8s aggregation window（防 idle 洗版）
                          ├─ rowSignalRank()（idle=0, tool=2, error=3）
                          ├─ groupFeedIntoTasks()（組合成 task）
                          ├─ conversationFeedCache（從 sessions_history 合成對話 rows）
                          └─ detailTaskLabel()（抽 user-facing label）
```

---

## 三、key Functions（重要函式索引）

| 函式 | 位置 | 職責 |
|------|------|------|
| `buildFeedV3Rows()` | index.ts | Feed row 生成核心，含 aggregation + ranking |
| `rowSignalRank()` | index.ts | 決定哪些 row 可以覆蓋哪些；idle=0 不能覆蓋有意義 row |
| `detailTaskLabel()` | index.ts | 從 event details 抽白話 label；含 isGenericTaskLabel() 過濾 |
| `isGenericTaskLabel()` | index.ts | 過濾 generic/tautological labels（如 `Scheduled task` / `Task`） |
| `groupFeedIntoTasks()` | index.ts | 把 raw events 組合成 task 群組 |
| `conversationFeedCache` | index.ts | 從 sessions_history 合成 conversation_turn rows |
| `feedReplyingText()` | app.js | Now panel reply wording |
| `feedCommandIntent()` | app.js | command intent → 白話 mapping |
| `fmtWhat()` | app.js | Frontend 最終 `what` 顯示邏輯 |
| `feedNormalizeAgentId()` | app.js | agentId 過濾（抑制 internal token） |

---

## 四、feed Row kind 說明

| kind | 意義 | 進 Feed 條件 |
|------|------|-------------|
| `before_agent_start` | 新 task 開始 | 僅 helper/scheduled/labeled task |
| `after_tool_call` | tool 完成 | 僅 canonical tools（exec/read/write/edit/browser/sessions_spawn） |
| `before_tool_call` | tool 開始 | 同上 |
| `message_sending` | 正在回覆 | 是 |
| `message_sent` | 回覆已發出 | 是 |
| `agent_end` | task 結束 | 僅 helper/scheduled/labeled/failure |
| `conversation_turn` | 合成對話 row | 是（從 sessions_history） |
| `presence` / `state` | 狀態變化 | 僅有意義 state（thinking/tool/reply/error）|
| `tool_result_persist` | 內部儲存鉤子 | **不進 Feed** |

---

## 五、已知的設計決策（Decisions Log）

| 決策 | 理由 |
|------|------|
| `subagent` 這種 agentId 視為 internal，不外露 | user-facing label 不應含 internal jargon |
| `tool_result_persist` 不出現在 Now panel | 這只是內部儲存鉤子，不是使用者可理解的狀態 |
| `Idle` vs `idle · 5s ago`：統一用 `Idle` | `idle · Ns ago` 機械感太重，偏離白話目標 |
| `Completed command` 不能沒有最低資訊量 | Feed 是歷史記錄，完全沒有資訊量的 row 等於無用 |
| Raw command 字符串嚴禁進 `what` | Command 內容可能含 URL/TOKEN，直接暴露是安全問題 |
| `idle` (rank=0) 不能覆蓋有意義 row | 防止 idle presence 把 tool/reply 洗掉 |
| Conversation rows 從 sessions_history 合成 | 對話本身是有意義的 agent 行為，應該進 history |
| 8s aggregation window | 防短時間重複狀態洗版，但不跨 rank 合併 |

---

## 六、PM Plan v1（執行中）

### Phase 1：系統性根治

| ID | 項目 | 狀態 | 備註 |
|----|------|------|------|
| P1.1 | Now panel 重建，走 detailTaskLabel() | 待執行 | Now 目前繞過白話 logic |
| P1.2 | Conversation rows 修 Frontend | 待執行 | Backend 有，但 app.js fmtWhat() 沒處理 |
| P1.3 | Internal token / jargon 全面 suppress | ✅ 完成（18f6e40） | subagent / discord 等 |
| P1.4 | Completed command 最低資訊量 | ✅ 完成（f73b486/428adbc/77052b6） | 不能 alone 無意義結束 |
| P1.5 | Raw command 不泄漏到 what | ✅ 完成（77052b6） | aggregation 時 command 不進 what |
| P1.6 | Now/Face wording 統一 | ✅ 完成（0eae320 + uncommitted） | idle · Ns ago 統一 |

### Phase 2：設定功能

| ID | 項目 | 狀態 |
|----|------|------|
| P2.1 | History retention 設定 | 待執行 |
| P2.2 | Settings panel UX | 待執行 |

### Phase 3：UX 品質

| ID | 項目 | 狀態 |
|----|------|------|
| P3.1 | QA UX checklist 正式化 | 待執行 |

---

## 七、Commit 規範

每次 commit message 格式：
```
<type>(<scope>): <一句話說做了什麼>

問題：<為什麼要改>
做法：<改了什麼>
驗收：<如何驗證>
相關：PM Plan v1 — P1.x
```

---

## 八、殘留問題追蹤

| 問題 | 根源 | 對應 |
|------|------|------|
| `subagent` jargon 外露 | agentId 沒過濾 | P1.3 |
| `Completed command` 無資訊量 | fallback 太 generic | P1.4 |
| Raw curl/command 进 what | aggregation 沒 sanitize | P1.5 |
| Now panel 露 `tool_result_persist` | Now 走別的 path | P1.1 |
| `conversation_turn` 不顯示 | Frontend fmtWhat() 沒處理 | P1.2 |
| `idle · 5s ago` 太機械 | Now wording 已統一 | ✅ P1.6 |
| Retention 設定不存在 | 功能未實作 | P2.1 |
