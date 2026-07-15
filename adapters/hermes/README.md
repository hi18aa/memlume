# Hermes Adapter

此 Adapter 以 Hermes 的 General Plugin hook 將對話接到本機 Memlume Shared Brain。它不讀取、不修改、也不取代 Hermes 原本的 `MemoryProvider`；兩者可獨立並存。

`pre_llm_call` 取得的 Shared Context 只暫時注入當前回合，不會寫回 Hermes 的 conversation history 或 session database。只有使用者訊息會經 `onUserMessage` 交給 Memlume Core 判斷是否形成記憶、是否需確認、是否可寫入指定 Brain。

## 安裝

此 Plugin 必須位於（或以 symlink 指向）已 checkout 的 Memlume repository 內：`adapters/hermes`。請依 Hermes General Plugin 的安裝方式，讓它載入這個資料夾的 `plugin.yaml`；不要複製 `bridge.mjs` 到獨立目錄，因為 bridge 會使用同一個 repository 已建置的 `@memlume/adapter-sdk`。

先建置 SDK：

```powershell
pnpm --filter @memlume/adapter-sdk build
```

建議先由 `memlume setup adapter hermes` 建立本機 profile；它會註冊 installation、掛載 Brain、執行 daemon smoke test，並把 token 保留在使用者帳號的 Memlume 設定檔（不會寫入 `plugin.yaml`、Git 或日誌）。Hermes 會自動讀取這個 profile。

下列環境變數仍可用於暫時覆寫 profile，適合進階或 CI 使用：

```powershell
$env:MEMLUME_DAEMON_URL = 'http://127.0.0.1:3849'
$env:MEMLUME_TOKEN = 'adapter-token'
$env:MEMLUME_INSTALLATION_ID = '00000000-0000-7000-8000-000000000010'
$env:MEMLUME_PROFILE_ID = '00000000-0000-7000-8000-000000000011'
$env:MEMLUME_PROJECT_ID = '00000000-0000-7000-8000-000000000012'
$env:MEMLUME_BRAIN_ID = '00000000-0000-7000-8000-000000000013'
$env:MEMLUME_WORKSPACE_PATH = 'C:/work/memlume' # 選填
```

預設 bridge 為本資料夾的 `bridge.mjs`，並使用 `node`。若 Hermes 不是從此 repository 路徑載入，可設定絕對路徑：

```powershell
$env:MEMLUME_NODE_BRIDGE = 'C:/work/memlume/adapters/hermes/bridge.mjs'
$env:MEMLUME_NODE_BINARY = 'node' # 選填
```

## Hook 對應

| Hermes hook | Memlume 行為 |
| --- | --- |
| `pre_llm_call`（主 Agent） | 先非阻塞送出使用者訊息作為 Project Brain capture，再在短暫上限內以 `beforeTask` 解析已掛載的 **Project → Domain（Company）→ Personal** Shared Context；失敗時直接繼續原對話。 |
| `subagent_start` | 僅登錄 child session，不注入 Context、不寫入記憶。child 的第一次 `pre_llm_call` 才以 `onSubagentStart` 取得只讀的 Project Brain Context；不會回退到 Domain 或 Personal。 |

例如「`記住專案使用 pnpm`」會連同 `{ level: 'project', projectId }` 與 `MEMLUME_BRAIN_ID` 送到 Core。一般訊息可被忽略；完整 transcript、assistant output、暫時推理與秘密資料不會形成自動 capture。Core 仍負責敏感資料過濾、候選審核、衝突治理與 mount 授權；Adapter 不自行保存、重試或模擬 Hermes 的私有記憶。

明確記憶暫時無法送達時，SDK 只會將安全的請求排入本機 outbox，並在下一次 `pre_llm_call` 的 `beforeTask` 或 `onUserMessage` 重送。Brain 是資料歸屬與權限邊界，Hook 只決定何時觸發。

## 驗證

```powershell
pnpm run test:hermes
```

此測試包含 Python hook mapping，以及 Node bridge 經 `AdapterClient` 寫入 fake daemon 的測試，確認 token 不會出現在 bridge 回應。
