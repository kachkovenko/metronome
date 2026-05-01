# Метроном

PWA-метроном для тренировки игры на барабанах. Чистый JS, без билда.

**Live:** https://kachkovenko.github.io/metronome/

## Возможности

### Метроном

- Темп **30–300 BPM**: горизонтальное колесо прокрутки тиков, кнопки ±1/±5, поле ввода, **tap tempo**
- **Размер** от 1/2 до 12/16, любая комбинация числителя и знаменателя
- **Деления**: четверти / восьмые / триоли / шестнадцатые
- **Per-beat акценты** — каждая доля в такте это стопка из 3 точек, тап циклит состояние:
  - **Акцент** — высокий клик (1500 Hz)
  - **Доля** — обычный клик (900 Hz)
  - **Тихая** — приглушённый клик (700 Hz, в 2 раза тише)
  - **Пропуск** — тишина
- **Speed Trainer** — автоматический разгон BPM с шагом N в каждые M тактов
- **Случайные пропуски долей** — тренирует внутренний пульс
- **Пресеты** — 7 встроенных + свои в `localStorage`
- **Хоткеи** на десктопе: пробел = старт/стоп, T = tap tempo (на тач-устройствах подсказка скрыта)

### Тренировки

Структурированные планы сессий в виде JSON в [`sessions/`](sessions/).

Walkthrough-режим:

- Автоматически выставляет BPM, размер, деления, per-beat акценты на каждое упражнение и стартует метроном
- Показывает заголовок, инструкции, **стикинг** (`R L R L`), **ноты** в виде сетки хэт/мал./бочка с `×` и `●`
- Прогресс-бар таймера
- Кнопки навигации `←` / `→` и подкрутки `−5 BPM` / `+5 BPM`
- Свободная игра (заминка) — таймер без метронома

Сейчас в репо одна сессия: [`drum-beginner-session.json`](sessions/drum-beginner-session.json) (≈60 минут, 5 блоков).

### Bluetooth-задержка наушников

- **Автоопределение** через `audioCtx.outputLatency` при каждом старте
- **Ручной режим** со слайдером 0–400 мс и пресетами (Проводные / Bluetooth / AirPods)
- Визуальный индикатор сдвигается на `btLatencyMs` мс позже звука, чтобы вспышка совпадала с щелчком в наушниках
- На iPhone типичные значения: AirPods 130–180 мс, не-Apple BT 160–220 мс

### PWA

- Установка как приложение на iPhone / Android / macOS / Windows
- **Офлайн-режим** через service worker
- **Версия + кнопка «Обновить»** в бургер-меню; при наличии новой версии — `SKIP_WAITING` → `controllerchange` → reload → тост подтверждения
- Иконки PNG 180/192/512, апп-стайл иконка для iOS

### iOS-фиксы

- **Silent switch обходится** через тихий `silent.mp3` на лупе (HTMLAudioElement переводит iOS audio session в режим `playback`, который игнорирует физический переключатель беззвучного режима)
- `start()` ждёт `audioCtx.resume()`, при сбое показывает тост

## Стек

- Чистый JS / HTML / CSS, **без билда** (просто статика на GitHub Pages)
- **Web Audio API** для точного тайминга — lookahead-планировщик из «A Tale of Two Clocks» Криса Уилсона
- **Service Worker** для офлайна и обновлений
- Шрифт **Google Sans** через Google Fonts

## Структура репо

```
.
├── index.html              UI и разметка модалок
├── app.js                  Вся логика (scheduler, sessions, BT latency, PWA hooks)
├── styles.css              Стили — чёрный фон, лайм акцент, Google Sans
├── manifest.json           PWA manifest
├── sw.js                   Service worker с SKIP_WAITING flow
├── icon.png                Мастер-файл иконки (1920×1920)
├── icon-{180,192,512}.png  Сгенерированные размеры
├── silent.mp3              Тихий MP3 для обхода iOS silent switch (1.3 KB)
├── sessions/               JSON-планы тренировок
│   └── drum-beginner-session.json
├── README.md               Этот файл
└── CHANGELOG.md            История версий
```

## Локальная разработка

```bash
cd ~/Documents/Metronome
python3 -m http.server 8765
```

Открыть http://localhost:8765 в браузере.

> Service Worker не работает через `file://` — нужен HTTP-сервер. Микрофон тоже потребует HTTPS, но `localhost` считается «безопасным происхождением».

## Релиз

При выкатке новой версии **обязательно бамп обоих** значений в одном коммите:

1. `APP_VERSION` в [`app.js`](app.js) (например `'1.1.1'` → `'1.1.2'`)
2. `CACHE` в [`sw.js`](sw.js) (например `'metronome-v13'` → `'metronome-v14'`)

Без бампа `CACHE` service worker не подменит ассеты, и кнопка «Обновить» в установленной PWA вернёт «Вы используете актуальную версию».

```bash
# 1. Поправить код
# 2. Бампнуть оба значения
git add -A
git commit -m "..."
git push

# 3. Подождать ~1 минуту, GitHub Pages пересоберёт сайт
gh api repos/kachkovenko/metronome/pages/builds/latest --jq '.status'
```

В установленной PWA после деплоя: **бургер-меню → Обновить → тост подтверждает новую версию**.

## Добавление новой тренировки

1. Создать `sessions/<id>.json` (схема ниже)
2. Добавить путь в `SESSION_FILES` в [`app.js`](app.js)
3. Добавить путь в `ASSETS` в [`sw.js`](sw.js) — иначе сессия не закешится для офлайна
4. Бамп `APP_VERSION` + `CACHE`

### Схема JSON

```jsonc
{
  "id": "session-id",
  "title": "Название",
  "subtitle": "≈ 60 минут · уровень: ...",
  "blocks": [
    {
      "title": "Разминка",
      "subtitle": "5–10 мин",
      "exercises": [
        {
          "title": "Восьмые RLRL",
          "instructions": "Что делать в свободной форме",
          "sticking": "R L R L",                        // optional
          "bpm": 80,
          "timeSig": [4, 4],
          "subdivision": 2,                              // 1=четверти, 2=восьмые, 3=триоли, 4=шестнадцатые
          "beats": ["accent", "beat", "beat", "beat"],   // per-beat type для акцентов
          "durationSec": 240,
          "tip": "Подсказка курсивом",                   // optional
          "freePlay": false,                             // true = без метронома, только таймер
          "groove": {                                    // optional, ноты сеткой
            "labels": ["1", "и", "2", "и", "3", "и", "4", "и"],
            "rows": [
              { "name": "хэт",   "hits": ["x", "x", "x", "x", "x", "x", "x", "x"] },
              { "name": "мал.",  "hits": [".", ".", "o", ".", ".", ".", "o", "."] },
              { "name": "бочка", "hits": ["o", ".", ".", ".", "o", ".", ".", "."] }
            ]
          }
        }
      ]
    }
  ]
}
```

`hits` поддерживает `"x"` (крестик), `"o"` (закрашенный кружок) и `"."` (пусто).

## Деплой

GitHub Pages из ветки `main`, корень `/`. Конфигурация заведена один раз через `gh api -X POST repos/.../pages`.

URL: https://kachkovenko.github.io/metronome/

## Что не закоммичено

В `.gitignore`:

- `BACKLOG.md` — список идей и фич в работе
- `Practice/` — PDF-исходники тренировок и заметки
- `visual reference/` — мудборды

## Ссылки

- [CHANGELOG.md](CHANGELOG.md) — история версий
- [Live app](https://kachkovenko.github.io/metronome/)
- [Repo](https://github.com/kachkovenko/metronome)
