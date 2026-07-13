# Adapter 共用合約

各 Agent Adapter 只負責把 Host 的生命週期事件轉成 Memlume 呼叫；記憶是否應保存、衝突處理、敏感資料過濾與 Brain 掛載授權，一律由 Memlume Core 判斷。

請共用 `fixtures/host-events.ts`，不要各自重做相同流程，也不要讀取、模擬或同步 Host 的私有長期記憶。

```ts
import { AdapterClient } from '@memlume/adapter-sdk';
import { createAdapterHostCallbacks } from '../fixtures/host-events.js';

const callbacks = createAdapterHostCallbacks(new AdapterClient({ daemonUrl, token }));
callbacks.initialize({ envelope });
```

## 初始化與四個生命週期 callback

每個 Host session 先完成初始化步驟，接著依序使用四個生命週期 callback：

`initialize({ envelope })` 是初始化步驟，不算 lifecycle callback。`envelope` 必須帶 `clientType`、`installationId`、`profileId`、`sessionId`、`projectId`；`workspacePath` 可選。
同一個 callback instance 重新初始化時，`clientType`、`installationId`、`profileId` 必須相同；可更換 `sessionId`，但不同 Adapter 身分會 fail-closed。

1. `beforeTask(...)`：在 Agent 開始任務、準備讀取上下文時呼叫。最多給既有 outbox 很短的重送寬限；若仍未完成便讓重送在背景繼續。Context 讀取有短暫上限，Daemon 無法連線、逾時或讀取失敗時必須 fail-open：以空 Context 繼續原任務，不能阻擋 Host。
2. `onUserMessage(...)`：使用者訊息到達時呼叫。這是「候選記憶」的輸入，不代表 Host 自行宣告已保存。
3. `afterTask(...)`：任務完成後寫入可稽核事件；不要將它當成第二套記憶判斷器。
4. `onSessionEnd()`：session 關閉前呼叫，用既有 outbox 重試暫存的可重送寫入。

初始化前收到事件是 Adapter 整合錯誤，應立即失敗，避免未知身分寫入。

## 寫入結果與離線行為

Adapter 必須原樣回報 SDK 結果，不能把請求已送出或已排隊說成已保存：

| 結果 | Host 可顯示的意思 |
| --- | --- |
| `saved` | Daemon 已確認保存；capture 另會帶 Core 判定的記憶狀態。 |
| `queued` | Daemon 暫時不可用，且 SDK 已安全寫入本機 outbox，待下一次 callback 或 `onSessionEnd()` 重試。 |
| `rejected` | 授權、掛載、輸入或安全規則拒絕，沒有保存。 |
| `ignored` | Core 判定不形成記憶，沒有保存；這不是錯誤。 |

不要在 Adapter 自行建立另一個 retry queue。SDK 只會將符合安全與明確記憶請求條件的可重送 capture 放入 outbox；永遠不要把 token 或敏感訊息寫進 outbox。

## Brain 掛載

每次讀寫都由 Adapter token 對應的 installation 與 Brain mount 驗證。未掛載或唯讀 mount 的寫入會得到 `rejected`；Adapter 只能如實呈現結果，不得改寫 Brain ID、繞過授權，或以 Host 私有記憶補寫。

共用契約的 E2E 測試位於 `test/e2e/adapter-contract.test.ts`。新增 Hermes、Codex、Claude Code、OpenClaw 等 Adapter 時，應以該測試覆蓋其 Host event mapping。
