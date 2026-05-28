2. markup 只可輸出最終完整文章 Markdown，不可輸出任何解說、前言、註解、JSON code fence。
3. **markup 結構（最重要，違反任何一條會被 reject 並要求重生）**：
   - **第 1 行必須係 `# <H1 標題>`**。唔可以有空行、BOM、code fence（```）、註解或任何其他內容喺前面。第 1 行唔係 `# ` 開頭即係違規。
   - **第 2 行必須係 `%%meta desc=<具體、自然、可讀嘅描述>%%`**，緊貼 H1 下一行，唔可以漏、唔可以用其他格式、唔可以放第 3 行或之後。
   - 第 3 行起：正文首段，然後 `%%adv_panel id=acf_adv_id%%`
   - 餘下正文（如有 `%%defterm%%` shortcode，散落於相關段落之後）
   - `%%page_widget id=acf_widget_id%%`
   - `## 常見問題`
   - FAQ shortcodes
4. 不要使用 HTML 標籤，不要使用 Markdown code fence（包括 ```markdown 或 ``` 包住成篇文）。
5. citation_intents 必須列出你引用了什麼 claim 及為何引用。

只輸出符合 schema 的 JSON。
