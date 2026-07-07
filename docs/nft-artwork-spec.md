# FlipTheMeme — ТЗ на артворк NFT (Badges + Genesis)

Статус: артворка нет вообще. Оба контракта деплоятся с плейсхолдер-baseURI
(`ipfs://GENESIS_METADATA/`, `ipfs://YOUR_IPFS_HASH/` в `contracts/script/Deploy.s.sol`).
Технически всё заминтится и на мейннете без картинок — просто в кошельке/OpenSea
будет битая ссылка вместо изображения. Закрыть нужно до мейннета.

Две независимые коллекции: **Badges** (ERC-1155, soulbound, 16 штук) и
**Genesis** (ERC-721, передаваемый, максимум 20 штук).

---

## 1. Как контракты резолвят метаданные (важно для именования файлов)

### BadgeNFT.sol (`contracts/src/BadgeNFT.sol:93`)
```solidity
function uri(uint256 tokenId) public view override returns (string memory) {
    return string(abi.encodePacked(super.uri(tokenId), tokenId.toString(), ".json"));
}
```
Итоговый URL метаданных = `baseURI + tokenId + ".json"`.
Пример: baseURI = `ipfs://bafybei.../` → бейдж #7 резолвится в `ipfs://bafybei.../7.json`.

ERC-1155 стандарт также разрешает `{id}`-плейсхолдер (16-значный hex без `0x`,
без `.json`) — но раз контракт САМ приклеивает `tokenId + ".json"`, папка на IPFS
должна содержать файлы `1.json`, `2.json`, ..., `16.json` (обычные десятичные имена,
БЕЗ padding нулями, БЕЗ hex).

### GenesisNFT.sol (`contracts/src/GenesisNFT.sol:53`)
```solidity
function tokenURI(uint256 tokenId) public view override returns (string memory) {
    _requireOwned(tokenId);
    return string(abi.encodePacked(baseTokenURI, Strings.toString(tokenId), ".json"));
}
```
Та же логика: `1.json` ... `20.json` (tokenId = порядковый номер минта, 1–20,
см. `genesisNumber` mapping — это НЕ обязательно совпадает с итоговым владельцем,
т.к. NFT передаваемый).

**Вывод:** нужны две IPFS-папки, каждая с файлами `1.json` … `N.json` (плоская
структура, без вложенных папок), плюс сами картинки рядом или по отдельному пути,
на который эти JSON ссылаются через поле `image`.

---

## 2. Коллекция Badges (16 штук, ERC-1155, soulbound — их нельзя ни продать, ни подарить)

Полный список с рарностью — из `contracts/src/BadgeNFT.sol:38-56` (ничего не выдумано,
это то, что реально в контракте):

| ID | Название | Рарность | Условие выдачи (для контекста дизайнеру) |
|----|----------|----------|-------------------------------------------|
| 1 | Beginner | common | 1-я ставка |
| 2 | On Fire | common | 7 побед подряд |
| 3 | Diamond | rare | 30 побед подряд |
| 4 | Sniper | rare | 10 побед подряд |
| 5 | Speed | common | ставка на 5-минутном рынке |
| 6 | Whale | rare | объём ставок ≥ $500 |
| 7 | To The Moon | epic | выигрыш при движении цены ≥10% |
| 8 | Oracle | epic | ≥100 ставок и winrate ≥80% |
| 9 | Legend | legendary | 100 побед подряд |
| 10 | Champion | legendary | #1 в недельном лидерборде прямо сейчас |
| 11 | Pepe Master | common | 50 ставок на PEPE |
| 12 | Brett Fan | common | 50 ставок на BRETT |
| 13 | Pro | rare | объём ставок ≥ $10,000 |
| 14 | Institutional | epic | объём ставок ≥ $100,000 |
| 15 | Connector | rare | 5 активных рефералов |
| 16 | Network | epic | 20 активных рефералов |

### Визуальная иерархия по рарности
Нужна чёткая ступенчатая эскалация — это единственное жёсткое визуальное требование:
- **common** (1,2,5,11,12) — простая монохромная иконка
- **rare** (3,4,6,13,15) — добавляется акцентный цвет/обводка
- **epic** (7,8,14,16) — более сложная композиция/градиент/эффект свечения
- **legendary** (9,10) — самый насыщенный вариант, можно с анимированной версией (см. п.5)

### Стиль (текущая дизайн-система сайта, `frontend/src/index.css`)
- Фон: чёрный `#07070a` / `#0a0a0e`
- Акценты: `--up: #4d8dff` (синий — НЕ зелёный, несмотря на то что в старом ТЗ
  фигурировал зелёный/красный; актуальный сайт использует сине-розовую палитру),
  `--down: #ff3d6e` (розово-красный), `--warn: #ffb547` (янтарный)
- Шрифт в UI: JetBrains Mono (моно, technical/terminal эстетика)
- Референс на pump.fun-подобную эстетику из исходного ТЗ по-прежнему в силе:
  минимализм, крупная форма, читаемо в 40×40px (аватарка в интерфейсе)

---

## 3. Коллекция Genesis (до 20 штук, ERC-721, ПЕРЕДАВАЕМЫЙ NFT)

Из `contracts/src/GenesisNFT.sol` + `docs/flipthememe-addendum-coldstart.md`:
- Даёт держателю 1.5× буст к доле комиссий пула — буст переходит вместе с NFT при продаже
- `genesisNumber` = порядковый номер минта (1–20), не более 20 штук всего
- **Единственный шаблон**, отличается только числом (порядковый номер, крупно на арте)
- Можно (не обязательно) сделать визуальные вариации первых мест (1-3 — «топ-3»
  вариант оформления), но это опционально, не жёсткое требование

---

## 4. Формат JSON-метаданных (стандартный OpenSea/ERC-721/1155 schema)

### Badges — `{id}.json`
```json
{
  "name": "Sniper",
  "description": "10 wins in a row on FlipTheMeme.",
  "image": "ipfs://<CID_IMAGES>/4.png",
  "attributes": [
    { "trait_type": "Rarity", "value": "rare" },
    { "trait_type": "Badge ID", "value": 4 }
  ]
}
```

### Genesis — `{id}.json`
```json
{
  "name": "FlipTheMeme Genesis #7",
  "description": "Genesis LP #7 — 1.5x fee-share boost, transferable with the NFT.",
  "image": "ipfs://<CID_IMAGES>/7.png",
  "attributes": [
    { "trait_type": "Genesis Number", "value": 7 },
    { "trait_type": "Fee Boost", "value": "1.5x" }
  ]
}
```

---

## 5. Технические требования к файлам изображений

- Формат: PNG (прозрачный фон необязателен — фон чёрный по стилю) или SVG
- Размер: 1000×1000px минимум (стандарт для OpenSea/маркетплейсов), квадрат
- Вес: до ~500KB на файл (IPFS/загрузка в кошельках)
- Итого: **16 картинок бейджей + до 20 картинок Genesis** (Genesis можно как один
  шаблон + программная вставка номера при экспорте, не обязательно рисовать 20 раз руками)
- Опционально (не блокирует мейннет): анимированная версия для legendary (9, 10) —
  GIF/MP4, OpenSea поддерживает через отдельное поле `animation_url`

---

## 6. Процесс заливки на IPFS

1. Собрать `badges/1.png … 16.png` + `badges/1.json … 16.json` (JSON ссылается на
   картинку либо тем же CID через относительный путь, либо на отдельно залитую
   папку картинок — оба варианта рабочие, главное чтобы `image` в JSON резолвился)
2. Аналогично `genesis/1.png … 20.png` + `genesis/1.json … 20.json`
3. Залить каждую папку как отдельную директорию на IPFS (Pinata — ключ уже есть
   в `.env.example: PINATA_API_KEY`, просто не заполнен) — получить CID папки
4. Обновить в `contracts/script/Deploy.s.sol`:
   - строка 77: `"ipfs://GENESIS_METADATA/"` → `"ipfs://<CID_GENESIS>/"`
   - строка 83: `"ipfs://YOUR_IPFS_HASH/"` → `"ipfs://<CID_BADGES>/"`
5. **Важно:** baseURI задаётся один раз в конструкторе и неизменяем для BadgeNFT
   (нет сеттера); у GenesisNFT есть `setBaseURI` (onlyOwner) на случай, если
   понадобится перезалить после деплоя — но по-хорошему делать это ДО мейннет-деплоя,
   чтобы не тратить лишнюю транзакцию

---

## Чеклист

```
[ ] 16 картинок бейджей (мин. 1000×1000px), с визуальной иерархией по рарности
[ ] 16 JSON-файлов метаданных бейджей (1.json–16.json)
[ ] До 20 картинок Genesis (можно 1 шаблон + программная вставка номера)
[ ] До 20 JSON-файлов метаданных Genesis (1.json–20.json)
[ ] Обе папки залиты на IPFS (Pinata), получены CID
[ ] Deploy.s.sol обновлён с реальными baseURI (строки 77 и 83)
[ ] Проверка: URL вида ipfs://<CID>/1.json открывается и отдаёт корректный JSON
[ ] Опционально: анимация для Legend/Champion (bage id 9, 10)
```
