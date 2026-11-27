# PDF 閱讀器 — Google Play 上架交接清單

> 文件更新：2026-11-27  
> Repository：`fung2222/pdf-zoom`  
> Web/PWA：<https://fung2222.github.io/pdf-zoom/>  
> 目前基準：`main`，Service Worker cache `pdf-zoom-v19`  
> 狀態：PWA 核心閱讀體驗已可供實機測試；**尚未完成 Google Play Android 封裝及正式上架驗收**。

---

## 1. 產品定位及不可退讓要求

本 App 主要用來閱讀大型 PDF，尤其工程／地盤圖則。定位是輕量、快速、穩定的 PDF 檢視器，不是 PDF 編輯器。

### 核心使用要求

- [x] 啟動後先到首頁，不自動跳入上次 PDF。
- [x] 首頁有「開啟 PDF」、「最近開啟」、「收藏」。
- [x] 支援 Android 分享 PDF 進入 App（Web Share Target 流程已寫入 manifest/service worker，仍須在最終 Android 封裝中實機驗證）。
- [x] 開啟 PDF 後以符合螢幕闊度、垂直置中的方式顯示。
- [x] 雙指縮放、單指平移、雙擊縮放。
- [x] 平移時圖紙即時跟隨手指，不可等放手才跳動。
- [x] 縮放／移動期間保留底層圖像，避免黑屏或白屏；高清內容完成後再替換。
- [x] 最近開啟及收藏資料使用本機 IndexedDB。
- [ ] 真實 Android 多機型、大型工程 PDF 壓力測試完成。
- [ ] Google Play 封裝、政策資料、商店素材及正式發佈完成。

### 產品原則

1. 手指操作優先：平移及縮放不能被 PDF 高清重繪阻塞。
2. 畫面連續優先：高清重繪期間保留舊圖或低清預覽，禁止整頁閃白／閃黑。
3. 先顯示可見內容，再補畫周邊高清內容。
4. 不以無限制增加 Canvas、快取或預載來換速度；必須同時監控 Android 記憶體。
5. 所有效能結論必須以同一部手機、同一份 PDF、同一操作方式量度。

---

## 2. 目前技術架構（以 main 程式碼為準）

| 項目 | 現況 |
|---|---|
| 前端 | 原生 HTML / CSS / JavaScript ES modules |
| PDF 引擎 | PDF.js **4.10.38** |
| PDF Worker | `vendor/pdf.worker.min.mjs`，必須與 PDF.js API 版本一致 |
| 部署 | GitHub Pages，純靜態網站 |
| PWA | `manifest.webmanifest` + `sw.js` |
| 離線 | Service Worker 預載 App shell、PDF.js 主程式及 Worker；cMaps／standard fonts 另作快取 |
| 本機資料 | IndexedDB（最近開啟、收藏及 PDF Blob） |
| 分享入口 | manifest 的 `share_target` + Service Worker POST `/share-target` |
| 渲染 | 全頁低清 preview + 單一可視區域高清 detail canvas |
| 手勢 | Pointer Events；`requestAnimationFrame` 更新 CSS transform |
| Service Worker cache | `pdf-zoom-v19` |

### 重要程式位置

- `index.html`：首頁、閱讀器結構及入口。
- `css/app.css`：版面、閱讀器及安全區樣式。
- `js/app.js`：PDF 開啟、手勢、Canvas 渲染、IndexedDB。
- `manifest.webmanifest`：PWA 設定及分享目標。
- `sw.js`：離線快取及 Android 分享 POST 處理。
- `vendor/pdf.min.mjs`、`vendor/pdf.worker.min.mjs`：PDF.js API 及 Worker。
- `vendor/cmaps/`、`vendor/standard_fonts/`：PDF 字型／CMap 資源。

### 現有渲染限制及數值

以下是目前程式設定，不代表已證明是最佳值：

- Preview 上限：`MAX_PREVIEW_PIXELS = 800,000`。
- Detail Canvas 上限：`MAX_DETAIL_PIXELS = 8 × 1024 × 1024` pixels。
- Detail 單邊上限：`MAX_DETAIL_DIMENSION = 8192`。
- Detail 輸出 DPR 上限：2。
- Preview cache：最多 2 頁。
- Zoom scale 使用量化值，減少因極細微縮放差異而重複重繪。
- 手指拖動期間主要使用 CSS transform；放手後才安排高清 detail render。

---

## 3. 已知效能問題及下一步優化方向

### 使用者已確認

- [x] 平移已達到即時跟手的預期方式。
- [x] 縮放期間有底層圖像支撐，高清內容會在稍後補回。
- [ ] 平移／縮放後，高清內容重新載入仍比大型 PDF 閱讀器慢少許。
- [ ] 未有正式的冷啟動、暖啟動、高清補畫時間及記憶體數據。
- [ ] 未有與其他 PDF App 在同一裝置、同一 PDF 上的公平對照數據。

### 優先級 P0 — 先量度，不要盲目改參數

目前 `lastRenderMs` 主要記錄 PDF.js detail render 本身的時間，未完整涵蓋等待排程、取得 page、Canvas 建立、Canvas 換層等時間。下一輪應加上效能時間點：

- 開始選檔／讀取 Blob。
- `getDocument()` 完成。
- `getPage()` 完成。
- Preview 開始及首次可見。
- Detail render 開始及完成。
- Detail Canvas 顯示／替換完成。
- 每次手勢放手至高清可見的總時間。

建議記錄 p50、p95，不要只看最快一次。除非使用者明確同意，效能記錄只保留本機，不收集 PDF 名稱、內容或個人資料。

### 優先級 P1 — 高清補畫採用「可視區優先」

目前 `renderDetail()` 會將可視區及額外 overscan 範圍合併成一次 PDF.js render。大型向量圖則或複雜頁面時，整個較大的區域可能要完成後，使用者才看到新高清 Canvas。

建議下一階段原型：

1. 第一階段只渲染目前螢幕真正看見的區域，先令使用者正在看的線條變清晰。
2. 第一階段完成後，保留該高清畫面，再於空閒時間補畫周邊 overscan。
3. 周邊補畫未完成前，不可清走舊高清區域或低清底圖。
4. 使用 token／generation 防止舊頁面或舊縮放結果蓋過最新畫面。
5. 比較「一次大區域渲染」與「可視區先行」的 p50／p95，再決定採用方案。

### 優先級 P1 — 避免無謂取消高清渲染

目前第一隻手指 pointerdown 會呼叫 `cancelHiRender()`。即使使用者只輕觸畫面、沒有真正移動，亦可能取消正在進行的 detail render。

建議測試：延遲至手指移動超過小幅度門檻後才取消渲染；如果只是 tap，讓現有高清渲染繼續。必須測試 pointercancel、雙指轉單指及快速連續操作，避免造成舊畫面覆蓋新畫面。

### 優先級 P2 — 減少整份 PDF 的記憶體／儲存複製

目前開啟檔案會讀取整份 PDF 到 ArrayBuffer，再保留副本；IndexedDB 的最近開啟紀錄會儲存 PDF Blob，而 `saveLast()` 亦會把同一份 PDF Blob 再存一次。需要先確認 `kv:last` 是否仍有讀取用途，再考慮移除重複副本或改用單一檔案記錄。

不要直接刪除 `saveLast()`：先搜尋所有讀取點、確認舊版資料相容性，再做遷移。大型 PDF 的記憶體峰值及 IndexedDB quota 都要實測。

### 優先級 P2 — 智能預載及快取

- 只在裝置有餘裕時預先取得下一頁／上一頁的 page proxy 或低清 preview。
- 預載工作必須可取消，不能阻塞當前可視區高清渲染。
- 先量度 2 頁 preview cache 的命中率，再決定是否調整。
- 不建議直接把高清 Canvas cache 擴大；Canvas 佔用記憶體高，可能引起 Android WebView／Chrome GPU 記憶體壓力。

### 不應立即做的事

- 不要未量度就把 detail pixel 上限大幅提高。
- 不要在手指拖動期間持續重繪整頁 PDF。
- 不要同時升級 PDF.js、改渲染策略及改手勢系統；一次只改一個變數。
- 不要只用文字型小 PDF 作效能結論；工程圖則的向量路徑、圖片及字型負載可能完全不同。

---

## 4. 效能測試方法（每次改版都要填）

### 測試裝置及檔案

- Android 型號／RAM：
- Android 版本：
- Chrome 版本：
- 測試方式：Chrome 網頁／安裝 PWA／Google Play 封裝版
- PDF 檔案大小：
- PDF 頁數：
- PDF 類型：向量工程圖／掃描圖片／文字文件／混合
- 測試頁碼及縮放倍率：

### 必測數據

| 指標 | 測量方式 | 結果 |
|---|---|---|
| 開啟至首次有圖 | 點開 PDF 至第一張 preview 出現 | 待測 |
| 開啟至首次清晰 | 點開 PDF 至主要可視範圍高清 | 待測 |
| 平移後高清補畫 | 放手至新可視範圍高清 | 待測 |
| 縮放後高清補畫 | 放開雙指至新倍率高清 | 待測 |
| 操作流暢度 | 連續拖動及快速縮放，有否掉格／卡頓 | 待測 |
| 記憶體／穩定性 | 長時間操作、有否黑屏、重載或被系統關閉 | 待測 |

每項至少重複 10 次，分開冷啟動與暖啟動，記錄中位數及 p95。比較其他 PDF App 時，必須使用同一裝置、同一 PDF、同一頁、相同縮放倍率及相同操作路徑。

---

## 5. Android／Google Play 上架前清單

> 現時 repository 是 GitHub Pages PWA；尚未見到 Android Studio 專案、AAB、簽署設定或 Play Console 發佈設定。正式上架前必須選定封裝方式，不能把「PWA 可安裝」當成「已可上架 Google Play」。

### A. 決定 Android 封裝方式

- [ ] 決定使用 Trusted Web Activity（TWA／Bubblewrap）或 Capacitor／原生 Android 專案。
- [ ] 確認 package/application ID、App 名稱、版本號及最低 Android 版本。
- [ ] 設定正式 App icon、adaptive icon、splash screen。
- [ ] 設定 HTTPS 網域驗證（如採 TWA，完成 Digital Asset Links）。
- [ ] 確認檔案開啟、Android 分享 PDF 進入 App、返回鍵及外部連結行為。
- [ ] 確認離線啟動、Service Worker 更新及快取版本更新流程。
- [ ] 建立可重複產生的 release build 流程。

### B. Android 實機相容性

- [ ] 至少一部低／中階 Android 裝置及一部較新裝置。
- [ ] 手機直向、橫向及旋轉後版面。
- [ ] Android 系統檔案選擇器開啟 PDF。
- [ ] WhatsApp／其他 App 分享 PDF 進入本 App。
- [ ] 最近開啟、收藏、重新啟動後資料仍存在。
- [ ] 離線開啟已載入過的 App。
- [ ] 背景切換、鎖屏、返回 App 後可繼續使用。
- [ ] 大型 PDF、多頁 PDF、複雜向量圖、掃描 PDF。
- [ ] 加密／密碼 PDF、損壞 PDF、特殊字型／CMap。
- [ ] 低記憶體情況下不應無故黑屏或崩潰。

### C. Google Play Console 發佈資料

- [ ] 建立 Play Console App 記錄。
- [ ] 準備 Android App Bundle（AAB）及正式簽署金鑰／Play App Signing。
- [ ] 按提交當時 Play Console 要求設定 target API level。
- [ ] 填寫商店名稱、短描述、完整描述。
- [ ] 準備手機截圖、圖示及需要的宣傳圖片。
- [ ] 填寫 App 類別、聯絡電郵及支援網站。
- [ ] 準備公開 Privacy Policy 網址。
- [ ] 完成 Data safety 表格；如資料只在本機處理，仍須按實際 SDK、封裝方式及資料流準確申報。
- [ ] 完成 Content rating、廣告聲明（如適用）及 App access 聲明。
- [ ] 完成內部測試／封閉測試及 Play Console 要求的測試流程。
- [ ] 檢查 Play Console 最新政策、target API 及裝置相容性要求。

### D. 隱私及法律

- [ ] 寫清楚 PDF 是否只在裝置本機處理、有否上傳伺服器。
- [ ] 說明 IndexedDB 本機保存最近開啟及收藏檔案的用途。
- [ ] 說明如何刪除最近開啟／收藏及本機資料。
- [ ] 列出 PDF.js 等第三方開源元件及其授權。
- [ ] 如日後加入分析、廣告、崩潰回報或雲端同步，重新審視 Privacy Policy 及 Data safety。

---

## 6. 回歸測試清單（每次發佈前）

- [ ] 首頁正常顯示，不會自動開啟舊 PDF。
- [ ] 開啟新 PDF、最近開啟及收藏均正常。
- [ ] PDF 初始 fit-width 並垂直置中。
- [ ] 單指平移全程跟手。
- [ ] 雙指縮放時底圖持續存在。
- [ ] 縮放放手後高清內容會補回。
- [ ] 平移放手後新可視區會補回高清。
- [ ] 快速連續平移／縮放不會被舊 render 覆蓋。
- [ ] 到達頁面邊緣不會無限重繪或出現錯位。
- [ ] 換頁、上一頁／下一頁正常。
- [ ] WhatsApp 分享 PDF 正常。
- [ ] 關閉及重開 App 後首頁及本機資料正常。
- [ ] Service Worker 更新後沒有載入舊 JS／新舊 Worker 版本不匹配。
- [ ] 大檔案測試後沒有持續增加記憶體或黑屏。

---

## 7. 建議下一位開發者接手次序

1. 先在真實 Android 裝置記錄第 4 節效能基線，不要先改渲染常數。
2. 優先做「可視區高清先行、周邊高清後補」原型，與現有一次過 render 比較。
3. 測試 pointerdown 立即取消 render 是否造成不必要重繪。
4. 審查 `saveRecentFile()`、`saveLast()` 的重複 PDF Blob 儲存及啟動記憶體峰值。
5. 完成低／中階 Android 的長時間壓力測試。
6. 決定 TWA 或 Capacitor，再建立 Android 專案及 Play 測試軌道。
7. 只有當效能、穩定性及上架政策檢查通過後，才建立正式 release。

## 8. 交接注意事項

- 以 `main` 為目前整合基準；開始工作前先拉取最新程式碼。
- 每次只做一個主要效能改動，保留可回退 commit。
- PDF.js API 與 Worker 必須保持同一版本。
- 修改前先確認 Service Worker cache version 是否需要提升。
- GitHub Pages 部署完成不等於 Google Play Android 封裝已完成。
- 尚未在真實裝置驗證的項目，一律標示「待測」，不可寫成已通過。
