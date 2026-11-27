# PDF 放大閱讀器

最簡單嘅 PDF 閱讀器：開啟 PDF、放大到好大睇細節。向量渲染，任何倍數都保持清晰。

## 功能
- 開 PDF（揀檔案 / 分享到 App / 拖放）
- 雙指縮放、雙擊放大、拖動平移；最高 3000%
- 每頁按視窗大小即時重新渲染（唔係放大像素，所以唔糊）
- 上次睇過嘅檔案同頁數會自動記住（IndexedDB，唔上傳）
- 完全離線可用（Service Worker 預載）

## 部署
純靜態，任何 static host 都得（GitHub Pages / Netlify / 自己 server）。

## 開發及上架交接

- [Google Play 上架交接清單、目前架構、效能優化路線及測試表](GOOGLE-PLAY-HANDOFF.md)
