JSON-LD Schema 規則（去重 / dedup against Yoast）：
- 本文章發佈到 WordPress 時，**Yoast SEO 已自動 emit** 以下 schema.org 類型，**不要在 markup 中重複描述或手寫**：
  - `Article` / `WebPage` / `BreadcrumbList` / `WebSite`
  - `Organization` / `Corporation`（Bowtie 機構資訊、聯絡、社交連結）
  - `Person`（作者）
  - `ImageObject`（feature image）
  - 文章 `datePublished` / `dateModified` / `headline` / `articleSection` / `inLanguage`
- 不要在 H1、meta description、正文寫「Bowtie 創立於…」、「Bowtie 地址…」、「作者：…」、「發佈日期：…」、「分類：…」這類純機構/出版 metadata，因為 Yoast 已負責處理。
- **必須 emit** 的額外 schema：`FAQPage`（透過上方 FAQ shortcode；renderer 會自動轉成 JSON-LD）。
- **可選 emit** 的額外 schema：`DefinedTermSet` — 用於文章內專有名詞、英文縮寫、政策/醫學/保險術語。每個術語以下列 shortcode 表示，放在該術語**首次在正文出現之後的獨立空行**，不要連續多個堆在一起。每個 shortcode **必須三行獨立成行**（`%%defterm…%%`、描述、`%%end%%` 各佔一行），三行前後都要有 blank line：
   ```
   %%defterm name=術語%%
   一句解釋（≤ 60 字，香港繁體中文）
   %%end%%
   ```
   - `name` 為單行字串，可含空格（多字詞術語如 `Surat Rujukan`、`Klinik Kesihatan` 可接受），但不可含 `%` 或引號；用法見例：`%%defterm name=OGTT%%`、`%%defterm name=VHIS%%`、`%%defterm name=妊娠糖尿病%%`
   - 全文最多 6 個 `defterm`；如全文無真正需要解釋的術語，可不輸出
   - 不要為已在 H2 標題出現的常用詞重複定義
   - 不要在 description 內嵌 HTML / Markdown 連結 / 表情符號
   - **嚴禁 inline 寫法**：唔可以將 `%%defterm name=X%%…%%end%%` 塞喺同一行、塞入「」（）或句子中間。Inline 會令 renderer 漏出原始 marker 到 published HTML。
     - ✅ 正確：正文先寫「自願醫保（VHIS）為政府推行嘅醫保計劃」，之後留一個空行，再三行獨立寫 shortcode。
     - ❌ 錯誤：`配置一份「%%defterm name=自願醫保%%（VHIS）係政府推行嘅醫保計劃。%%end%%」亦是…`
   - 不要 emit 其他 schema 類型（如 `MedicalCondition`、`HowTo`、`Review`、`AggregateRating`、`Drug`、`MedicalProcedure`），renderer 不會處理，且部分有合規風險。
