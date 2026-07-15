# Adapter 共用合約

各 Agent Adapter 只負責把 Host 事件轉成 Memlume 共用 callback；記憶是否保存、衝突處理、敏感資料過濾與 Brain mount 授權，一律由 Memlume Core 判斷。Adapter 不讀取、模擬或同步 Host 的私有長期記憶，也不建立第二個資料庫或工作流。

請共用 `fixtures/host-events.ts`，不要各自重做共用流程。

```ts
import { AdapterClient } from '@memlume/adapter-sdk';
import { createAdapterHostCallbacks } from '../fixtures/host-events.js';

const callbacks = createAdapterHostCallbacks(new AdapterClient({
  daemonUrl,
  token,
  defaultWriteBrainId: projectBrainId,
}));
callbacks.initialize({ envelope });
```

## 初始化與三個共用 callback

`initialize({ envelope })` 是初始化步驟，不是 callback。`envelope` 必須帶 `clientType`、`installationId`、`profileId`、`sessionId`、`projectId`；`workspacePath` 可選。同一個 callback instance 重新初始化時，`clientType`、`installationId`、`profileId` 必須相同；可更換 `sessionId`，但不同 Adapter 身分會 fail-closed。

| Callback | Adapter 必須維持的邊界 |
| --- | --- |
| `beforeTask(...)` | 主 Agent 讀取 Context。未指定範圍時，Core 依已掛載 Brain 的 **Project → Domain（Company）→ Personal** 優先序解析；可要求較小的已授權範圍。讀取失敗必須 fail-open，以空 Context 繼續原任務。 |
| `onUserMessage(...)` | 唯一的自動 capture 入口；將符合資格的使用者訊息交由 Core 進行治理。主 Agent 寫入採明確 Brain → `defaultWriteBrainId`（Project Brain）→ `rejected`，永不回退 Personal。 |
| `onSubagentStart(...)` | 只讀取設定的 Project Brain Context，不讀取 Domain 或 Personal，不建立寫入，也不 flush outbox。Host 沒有可注入 child Context 的事件時，不得偽造支援。 |

Capture 治理：符合資格且非敏感的使用者訊息會追加為 immutable event。一般陳述可能成為待審核的 `candidate`；「記住」等明確要求可走 `active` 路徑，仍須經過衝突審核。空白或不支援事件會被 ignore，敏感資料會 redacted 或 rejected。

`onSubagentStart` 可接收 `parentTaskId` 與 `subagentId` 供 Host 對應，但 SDK 會在 Context request 前移除它們；Host 私有內容也不得送入 request。Brain 才是資料歸屬與權限邊界，Hook 只決定何時觸發。

## 寫入結果與離線行為

Adapter 必須原樣回報 SDK 結果，不能把請求已送出或已排隊說成已保存：

| 結果 | Host 可顯示的意思 |
| --- | --- |
| `saved` | Daemon 已確認保存；capture 另會帶 Core 判定的記憶狀態。 |
| `queued` | Daemon 暫時不可用，且 SDK 已安全寫入本機 outbox；outbox 僅接受明確記憶要求，待下一次 `beforeTask` 或 `onUserMessage` 重送。 |
| `rejected` | 授權、掛載、輸入或安全規則拒絕，沒有保存。 |
| `ignored` | Core 判定不形成記憶，沒有保存；這不是錯誤。 |

不要在 Adapter 自行建立另一個 retry queue。SDK 只會將符合安全與明確記憶請求條件的可重送 capture 放入 outbox；完整 transcript、assistant output、暫時推理、token 與敏感訊息都不能寫入 outbox。

## Brain 掛載

每次讀寫都由 Adapter token 對應的 installation 與 Brain mount 驗證。未掛載或唯讀 mount 的寫入會得到 `rejected`；Adapter 只能如實呈現結果，不得改寫 Brain ID、繞過授權，或以 Host 私有記憶補寫。

共用契約的 E2E 測試位於 `test/e2e/adapter-contract.test.ts`。新增 Hermes、Codex、Claude Code、OpenClaw 等 Adapter 時，應以該測試覆蓋其 Host event mapping。
