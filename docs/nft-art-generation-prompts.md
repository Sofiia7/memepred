# FlipTheMeme — промпты для генерации NFT-арта

Почему предыдущая попытка вышла инфографикой: в генератор скормили весь
`docs/nft-artwork-spec.md` целиком (контракты, JSON, IPFS, таблицы) одним
куском — модель восприняла это как "нарисуй диаграмму, объясняющую весь
этот текст", а не "нарисуй одну иконку". Плюс упоминания кода/JSON в промпте
почти гарантированно вызывают галлюцинированный fake-код на картинке.

**Правило:** один промпт = один файл = один запуск генератора. Не соединять
промпты, не упоминать контракты/JSON/IPFS в промпте для картинки — это
техническая часть ТЗ (`nft-artwork-spec.md`), генератору она не нужна и
только мешает.

Каждый промпт ниже самодостаточный — можно копировать по одному прямо в
генератор.

---

## Общий стиль (входит в каждый промпт ниже, не нужно добавлять отдельно)

```
Flat vector icon illustration, single centered symbol, minimalist,
dark background #0a0b0d, no text, no words, no letters, no code, no UI,
no diagram, no multiple panels — just one clean icon on a plain dark
square background. Square 1:1 composition.
```

## Цвета по уровню редкости (используются вместо серого/белого)

- common → монохром: серый/белый `#c9c9d1` контур, без цвета
- rare → акцент синий `#4d8dff`
- epic → акцент розово-красный `#ff3d6e` + лёгкое свечение/градиент
- legendary → акцент янтарный `#ffb547`, самый насыщенный, можно с эффектом свечения

---

## Badges (16 промптов)

### 1. Beginner (common)
```
Flat vector icon illustration, single centered symbol, minimalist,
dark background #0a0b0d, no text, no words, no letters, no code, no UI,
no diagram, no multiple panels. Square 1:1 composition.
Icon: simple monochrome silhouette of a person, outline style,
color #c9c9d1, no fill gradient, no effects.
```

### 2. On Fire (common)
```
[общий стиль как выше]
Icon: simple monochrome flame silhouette, outline style, color #c9c9d1,
no fill gradient, no effects.
```

### 3. Diamond (rare)
```
[общий стиль как выше]
Icon: faceted diamond gem, outlined in blue #4d8dff, subtle blue glow,
flat vector style, no gradient background.
```

### 4. Sniper (rare)
```
[общий стиль как выше]
Icon: crosshair/scope target symbol, blue #4d8dff outline and accent,
subtle glow, flat vector style.
```

### 5. Speed (common)
```
[общий стиль как выше]
Icon: simple monochrome lightning bolt silhouette, color #c9c9d1,
outline style, no fill gradient.
```

### 6. Whale (rare)
```
[общий стиль как выше]
Icon: minimalist whale silhouette, blue #4d8dff outline and accent,
subtle glow, flat vector style.
```

### 7. To The Moon (epic)
```
[общий стиль как выше]
Icon: rocket ship silhouette angled upward, pink-red #ff3d6e accent
and outline, gradient glow effect, more detailed/complex composition
than a plain silhouette (small flame trail, subtle motion lines).
```

### 8. Oracle (epic)
```
[общий стиль как выше]
Icon: mystical hooded figure silhouette or all-seeing eye symbol,
pink-red #ff3d6e accent and outline, gradient glow effect, more
detailed/complex composition than a plain silhouette.
```

### 9. Legend (legendary)
```
[общий стиль как выше]
Icon: ornate crown symbol, amber/gold #ffb547 accent, rich glow effect,
the most saturated and detailed icon in the set, subtle sparkle/light
rays around it.
```

### 10. Champion (legendary)
```
[общий стиль как выше]
Icon: trophy cup symbol, amber/gold #ffb547 accent, rich glow effect,
the most saturated and detailed icon in the set, subtle sparkle/light
rays around it.
```

### 11. Pepe Master (common)
```
[общий стиль как выше]
Icon: simple monochrome silhouette of a generic cartoon frog face
(rounded eyes, simple mouth line) — an original abstract frog icon,
NOT a copy of any specific existing frog character/meme artwork.
Color #c9c9d1, outline style, no fill gradient.
```

### 12. Brett Fan (common)
```
[общий стиль как выше]
Icon: simple monochrome silhouette of a generic cartoon dog face
(rounded ears, simple snout) — an original abstract dog icon, NOT a
copy of any specific existing meme character/mascot artwork.
Color #c9c9d1, outline style, no fill gradient.
```

### 13. Pro (rare)
```
[общий стиль как выше]
Icon: five-pointed star badge/medal symbol, blue #4d8dff outline and
accent, subtle glow, flat vector style.
```

### 14. Institutional (epic)
```
[общий стиль как выше]
Icon: simplified bank/institution building silhouette (columns,
triangular roof), pink-red #ff3d6e accent and outline, gradient glow
effect, more detailed composition than a plain silhouette.
```

### 15. Connector (rare)
```
[общий стиль как выше]
Icon: two connected circular nodes joined by a line, blue #4d8dff
outline and accent, subtle glow, flat vector style.
```

### 16. Network (epic)
```
[общий стиль как выше]
Icon: multiple circular nodes connected in a small network/web pattern
(more nodes than "Connector"), pink-red #ff3d6e accent and outline,
gradient glow effect, more detailed/complex composition.
```

---

## Genesis (1 промпт — шаблон, номер вставляется программно потом)

```
Flat vector illustration, dark background #0a0b0d, no diagram, no
multiple panels, no code, no JSON. Square 1:1 composition.
A single elegant badge/seal/medallion design, blue #4d8dff accent,
centered, with empty clean space in the middle reserved for a large
number (leave that area plain/uncluttered — the number gets added
separately afterward). Do not render any text or digits yourself.
```

После генерации шаблона номер (1–20) добавляется поверх программно
(Pillow, как в `scripts/generate-genesis-nft-art.py`), не нужно просить
генератор рисовать 20 версий с разными числами.

---

## Что делать с результатом

1. Каждый промпт → отдельный запуск → один PNG.
2. Файлы должны быть минимум 1000×1000px (попроси генератор явно, если
   есть настройка размера; иначе апскейлить после через Pillow/любой
   апскейлер — вырезать один маленький значок из инфографики, как в
   прошлый раз, не вариант).
3. Дальше по чеклисту в `docs/nft-artwork-spec.md`: разложить по
   `1.png … 16.png` (бейджи по ID из таблицы, не по порядку из этого
   файла) и `1.png … 20.png` (Genesis), сделать JSON, залить на IPFS.
