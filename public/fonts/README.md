# 自托管字体（Claude 设计系统）

这些 woff2 由 `public/css/modern-verify.css` 顶部的 `@font-face` 自托管引用。
因 `src/main.ts` 的 CSP `fontSrc` 已包含 `'self'`，自托管字体**无需任何 CSP 改动**，且对 Telegram WebView 离线/弱网友好。

## 当前文件

| 文件 | 字体 | 用途 | 许可 |
|---|---|---|---|
| `cormorant-garamond-600.woff2` | Cormorant Garamond 600（latin 子集） | 标题 serif（`--font-display`，weight 600 让中文宋体更厚重） | SIL OFL 1.1 |
| `inter-400.woff2` | Inter 400（latin 子集） | 正文（`--font-body`） | SIL OFL 1.1 |
| `inter-500.woff2` | Inter 500（latin 子集） | 正文强调/标签 | SIL OFL 1.1 |

来源：[fontsource](https://fontsource.org)（jsDelivr CDN）。均为 latin 子集，体积极小（合计约 70KB）。

## 中文标题的 serif 效果

Cormorant Garamond / Inter 仅含 latin 字形。中文字符（如「入群验证」）会按 `--font-display`
回退链自动使用**系统中文衬线**：

```
--font-display: 'Cormorant Garamond', Georgia, 'Songti SC', 'STSong',
                'Noto Serif CJK SC', 'Noto Serif SC', 'Source Han Serif SC', serif;
```

- macOS / iOS（含 Telegram 客户端）→ `Songti SC` / `STSong`（宋体，编辑感 serif）
- Android → `Noto Serif CJK SC`（若系统内置）
- 兜底 → 通用 `serif`

因此中文标题在主流端均能呈现衬线编辑气质，无需下载任何 CJK 字体。

## 若想让中文标题用自托管 serif（可选增强）

CJK 字体体积大（即便子集化也常达数百 KB ~ 数 MB）。如确有需要：
1. 用 [`fonttools`](https://github.com/fonttools/fonttools) / [`subset-font`](https://www.npmjs.com/package/subset-font) 对 Noto Serif SC 按页面实际用字子集化；
2. 输出 `noto-serif-sc-subset.woff2` 放入本目录；
3. 在 `modern-verify.css` 新增对应 `@font-face` 并把它插入 `--font-display` 回退链最前的 CJK 位置。

## 替换 / 升级

直接替换同名 woff2 即可（保持文件名不变），或修改 `modern-verify.css` 中的 `@font-face` `src`。
缺失任一文件时，页面会自动回退到系统字体，不会报错或白屏。
