"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { timingSafeEqual } = require("node:crypto");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY = 10 * 1024;
const MAX_MESSAGE = 500;
const MAX_HISTORY = 6;
const RATE_LIMIT = 20;
const RATE_WINDOW = 60_000;
const DAILY_LIMIT = 500;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";
const SMS_CLIENT_KEY = process.env.SMS_CLIENT_KEY || "";
const ESKIZ_EMAIL = process.env.ESKIZ_EMAIL || "";
const ESKIZ_PASSWORD = process.env.ESKIZ_PASSWORD || "";
const ESKIZ_FROM = process.env.ESKIZ_FROM || "4546";
const LANGUAGES = new Set(["uz", "ru", "en"]);
const rateBuckets = new Map();
const sentSmsKeys = new Map();
const pendingSmsKeys = new Set();
let dailyBucket = { date: new Date().toISOString().slice(0, 10), count: 0 };
let eskizToken = "";
let eskizTokenAt = 0;
const greetingReplies = {
    uz: {
        greeting: "Salom! Kunora bo‘yicha qanday yordam kerak?",
        thanks: "Arzimaydi! Yana savolingiz bo‘lsa, bemalol so‘rang.",
        how: "Rahmat, yaxshiman! Sizga Kunora bo‘yicha yordam berishga tayyorman.",
        bye: "Xayr! Kunoringiz yaxshi o‘tsin!"
    },
    ru: {
        greeting: "Здравствуйте! Чем помочь вам в Kunora?",
        thanks: "Пожалуйста! Если появятся вопросы, обращайтесь.",
        how: "Спасибо, у меня всё хорошо! Готов помочь вам с Kunora.",
        bye: "До свидания! Хорошего дня!"
    },
    en: {
        greeting: "Hello! How can I help you with Kunora?",
        thanks: "You're welcome! Feel free to ask if you need anything else.",
        how: "I'm doing well, thanks! I'm ready to help you with Kunora.",
        bye: "Goodbye! Have a great day!"
    }
};

function sendJson(res, status, data) {
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
    });
    res.end(JSON.stringify(data));
}

function detectSmallTalk(message) {
    const text = message.toLocaleLowerCase().trim();
    const patterns = [
        ["uz", "thanks", /^(rahmat|katta rahmat|tashakkur|raxmat)[.!?…\s]*$/i],
        ["uz", "how", /^(qalaysan|qalaysiz|yaxshimisan|yaxshimisiz|ishlaring qalay)[.!?…\s]*$/i],
        ["uz", "bye", /^(xayr|ko'rishguncha|ko‘rishguncha|hayr)[.!?…\s]*$/i],
        ["uz", "greeting", /^(salom|assalomu alaykum|assalom|va alaykum assalom)[.!?…\s]*$/i],
        ["ru", "thanks", /^(спасибо|большое спасибо|благодарю)[.!?…\s]*$/i],
        ["ru", "how", /^(как дела|как ты|как вы|ты как)[.!?…\s]*$/i],
        ["ru", "bye", /^(пока|до свидания|до встречи)[.!?…\s]*$/i],
        ["ru", "greeting", /^(привет|здравствуйте|доброе утро|добрый день|добрый вечер)[.!?…\s]*$/i],
        ["en", "thanks", /^(thanks|thank you|many thanks)[.!?…\s]*$/i],
        ["en", "how", /^(how are you|how's it going|hows it going)[.!?…\s]*$/i],
        ["en", "bye", /^(bye|goodbye|see you)[.!?…\s]*$/i],
        ["en", "greeting", /^(hi|hello|hey|good morning|good afternoon|good evening)[.!?…\s]*$/i]
    ];
    return patterns.find(([, , pattern]) => pattern.test(text)) || null;
}

function knownHelpReply(message, lang, profile) {
    const text = message.toLocaleLowerCase();
    const intents = [
        ["profile", /(profil|профил|profile|maktab|school profile|life profile)/i],
        ["homework", /(uy vazifa|uyga vazifa|домашн.{0,8}задан|homework|home work)/i],
        ["grades", /(baho|baholar|bahoni|оценк|grade|grades)/i],
        ["diary", /(kundalik|дневник|diary)/i],
        ["event", /(tadbir|uchrashuv|событ|event|appointment)/i],
        ["breakTime", /(tanaffus|перемен|break time)/i],
        ["schedule", /(dars jadval|dars vaqti|расписан|урок|timetable|lesson schedule|lesson time)/i],
        ["taskFilter", /(filtr|qidiruv|qidir|поиск|фильтр|search|filter)/i],
        ["taskDone", /(bajarildi|bajarilgan|bajardim|bajarish|tugat|yakunla|галоч|выполнен|отмет|complete|completed|finish|mark.*done)/i],
        ["personalData", /(bugun.*(nima|reja)|rejam|vazifalarim|baholarim|мой.*(план|задач|оценк)|что.*сегодня|my (plan|tasks|grades)|what.*today)/i],
        ["taskAdd", /(vazifa|задач|task)/i],
        ["serverRun", /(server\.js|\bserver\b|localhost|\bport\b|ishga tush|запустить.*сервер|сервер.*запуст|\brun.*server\b|\bstart.*server\b)/i],
        ["habitStreak", /(streak|ketma.?ket|серия|подряд)/i],
        ["habit", /(odat|привыч|habit|heatmap|issiq.*xarita)/i],
        ["focus", /(fokus|pomodoro|таймер|focus|timer)/i],
        ["calendar", /(kalendar|календар|calendar)/i],
        ["calculator", /(kalkulyator|hisoblagich|калькулятор|calculator|calculate)/i],
        ["stats", /(statistika|статистик|hisobot|график|statistics|stats|chart)/i],
        ["language", /(tilni|til .*o'zgart|til .*o‘zgart|язык|language)/i],
        ["theme", /(mavzu|qorong|yorug|тем[аы]|тёмн|светл|dark mode|light mode|theme)/i],
        ["notifications", /(bildirish|уведомлен|notification|reminder)/i],
        ["export", /(eksport|экспорт|zaxira|резерв|копи|backup|export)/i],
        ["import", /(import|импорт|zaxira.*yukla|fayldan.*tikla|restore.*backup|восстанов.*копи)/i],
        ["clear", /(tozala|o'chir|o‘chir|удалить|очист|clear.*data|delete.*data)/i],
        ["storage", /(qayerda saql|saqlanadi|localstorage|brauzerda|где хранят|хранится|stored|saved.*where)/i],
        ["quickAdd", /(\+.*tugma|tezkor qo'sh|tezkor qo‘sh|быстр.*добав|quick add|plus button)/i],
        ["section", /(qayerda|qayerdan|topaman|где найти|где находится|where.*find|where is)/i]
    ];
    const intent = intents.find(([, pattern]) => pattern.test(text))?.[0];
    const replies = {
        uz: {
            profile: "Profilni Sozlamalar → Profil → Tahrirlash orqali almashtiring: «Maktab» profilida dars jadvali va baholar, «Mening kundalik hayotim» profilida esa shaxsiy rejalaringiz bor. Profil almashganda ma’lumotlar o‘chirilmaydi.",
            homework: "📘 Kundalikda kerakli kun va fan kartasini ochib «Uy vazifasi»ga yozing. «Vazifalarga qo‘shish»ni bossangiz, shu fan nomi va sana bilan vazifa yaratiladi; ayni kundalik yozuvidan qayta-qayta qo‘shilmaydi.",
            grades: profile === "student" ? "📘 Kundalikni ochib hafta va kerakli kunni tanlang, so‘ng fan kartasida 2, 3, 4 yoki 5 chipini bosing. Qayta bossangiz baho o‘chadi; baho faqat bugun yoki o‘tgan kunlarga qo‘yiladi." : "Baholar faqat «Maktab» profilidagi 📘 Kundalikda mavjud. Sozlamalar → Profil → Tahrirlash orqali Maktab profiliga o‘ting.",
            diary: profile === "student" ? "📘 Kundalik Maktab profilida kompyuterda chap menyuda, telefonda pastki menyuda. Haftani va Dushanba–Shanba kun chipini tanlang, so‘ng fan kartasini ochib baho, uy vazifasi yoki izohni kiriting." : "📘 Kundalik faqat Maktab profilida ko‘rinadi. Sozlamalar → Profil → Tahrirlash orqali Maktab profiliga o‘tsangiz, Kundalik va Dars jadvali menyuda chiqadi.",
            event: "Kun tartibi yoki pastki o‘ngdagi «+» orqali tadbir qo‘shing. Nomi, sana, boshlanish/tugash vaqti va kerakli boshqa maydonlarni to‘ldirib Saqlang; tadbirni tahrirlash yoki o‘chirish mumkin, vaqt to‘qnashsa saqlanmaydi.",
            breakTime: "Maktab profilida Dars jadvalini oching; dars va tanaffus vaqtlarini sahifaning pastidagi maydonlardan o‘zgartirib Saqlang. Standart katta tanaffus 10:15–10:30, Kundalikda esa dars holati va jonli soat ko‘rinadi.",
            schedule: "Dars jadvalini oching. Fan nomlarini «Tahrirlash» bilan, dars va tanaffus vaqtlarini pastdagi maydonlarda o‘zgartirib Saqlang; standart dars 08:00 da boshlanib 45 daqiqa davom etadi.",
            taskFilter: "Vazifalar bo‘limida Barchasi, Bajarilmagan va Bajarildi filtrlarini tanlang. Qidiruv maydoniga vazifa nomini yozib keraklisini topishingiz mumkin.",
            taskDone: "Vazifalar bo‘limida bajarilgan ish yonidagi katakchani belgilang; vazifa bajarilganlar filtriga o‘tadi. Belgini yana bossangiz bajarilmagan holatga qaytadi.",
            taskAdd: "Vazifalar bo‘limidagi «+ Vazifa qo‘shish»ni yoki pastki o‘ngdagi «+» tugmasini bosing. Nomi, muddati va ustuvorligini kiriting, xohlasangiz kategoriya va vergul bilan ajratilgan qism-vazifalarni qo‘shib Saqlang.",
            personalData: "Men shaxsiy vazifa, reja yoki baholaringizni ko‘ra olmayman, chunki ular brauzeringizda saqlanadi. Bugungi rejangizni Bosh sahifada, vazifalarni Vazifalarda, tadbirlarni esa Kalendar yoki Kun tartibida ko‘ring.",
            serverRun: "API kaliti kerak emas. Loyiha papkasida `node server.js` buyrug‘ini ishga tushiring va ilovani http://localhost:3000 manzilida oching; Node.js 18 yoki undan yangisi kerak.",
            habitStreak: "Odatlar bo‘limidagi issiqlik xaritasida bajarilgan kunlarni belgilang. Streak odat ketma-ket bajarilgan kunlarni sanaydi; kun katagini bosib bajarilish darajasini o‘zgartiring.",
            habit: "Odatlar bo‘limida «Odat yaratish»ni bosing, nomi, emoji va rangini kiriting. Issiqlik xaritasidagi kun katagini bosish darajani 1→2→3→4→0 aylantiradi; «Butun yil» yoki «Sentabr–bugun» ko‘rinishini tanlang.",
            focus: "Fokus bo‘limida standart 25 daqiqa ish va 5 daqiqa tanaffusni Boshlash, Pauza yoki Qayta boshlash tugmalari bilan boshqaring. Vaqtni yuqoridagi sozlamalardan o‘zgartirib Saqlang; oxirgi 6 sessiya tarixi ko‘rinadi.",
            calendar: "Kalendar bo‘limida Oy, Hafta yoki Kun ko‘rinishini tanlang. ‹ va › tugmalari bilan davrni almashtiring; sanani bosganda o‘sha kungi tadbirlar va vazifalar ko‘rinadi.",
            calculator: "Kalkulyator bo‘limida Oddiy, Ilmiy, Foiz va Vaqt farqi rejimlari bor; Maktab profilida O‘rtacha baho ham mavjud. Ilmiy rejimda DEG/RAD ni tanlang; klaviaturada Enter hisoblaydi, Backspace o‘chiradi, Esc tozalaydi.",
            stats: "Statistika bo‘limida vazifa va odat bajarilishi, streak, eng yaxshi kun, fokus vaqti hamda kategoriyalar ko‘rsatiladi. Maktab profilida baholar grafigi ham chiqadi.",
            language: "Sozlamalarni ochib Til bo‘limidan O‘zbekcha, Русский yoki English ni tanlang. Tanlov brauzeringizda saqlanadi.",
            theme: "Yorug‘ va qorong‘i mavzuni yuqori o‘ngdagi ◐ tugmasi bilan almashtiring; tanlovingiz saqlanadi.",
            notifications: "Sozlamalarda bildirishnomalarni yoqing va brauzer ruxsatini bering. Eslatma tadbirdan 5 daqiqa oldin, faqat sahifa ochiq turganida ishlaydi.",
            export: "Sozlamalarni ochib JSON eksport tugmasini bosing; zaxira fayli brauzeringizga yuklanadi. Ma’lumotlar avtomatik ravishda serverga yuborilmaydi.",
            import: "Sozlamalarda JSON importni tanlab, avval eksport qilingan Kunora zaxira faylini yuklang. Importdan oldin muhim ma’lumotlaringizni alohida zaxiralab qo‘ying.",
            clear: "Sozlamalarda «Barcha ma’lumotni tozalash»ni tanlang va tasdiqlang. Bu brauzerda saqlangan Kunora ma’lumotlarini o‘chiradi; avval JSON eksport qilib zaxiralash tavsiya etiladi.",
            storage: "Kunora ma’lumotlari login yoki server talab qilmasdan shu brauzer qurilmangizdagi localStorage’da saqlanadi. Boshqa qurilmaga o‘tkazish uchun Sozlamalardan JSON eksport/import qiling.",
            quickAdd: "Pastki o‘ngdagi «+» tezkor qo‘shish tugmasi ochiq sahifaga mos amalni bajaradi: oddiy sahifada tadbir, Vazifalarda vazifa, Odatlarda odat qo‘shadi.",
            section: "Kunora bo‘limlari kompyuterda chap menyuda, telefonda pastki menyuda. Qaysi bo‘lim kerakligini yozing — masalan, Kundalik, Vazifalar, Fokus yoki Sozlamalar."
        },
        ru: {
            profile: "Профиль меняется через Настройки → Профиль → Изменить. В профиле «Школа» доступны расписание и оценки, а в «Моя повседневная жизнь» — личное планирование; переключение не удаляет данные.",
            homework: "В 📘 Дневнике выберите день и предмет, затем заполните поле «Домашнее задание». Нажмите «Добавить в задачи», чтобы создать задачу с названием предмета и датой; повторно из той же записи она не добавится.",
            grades: profile === "student" ? "Откройте 📘 Дневник, выберите неделю и день, затем нажмите 2, 3, 4 или 5 в карточке предмета. Повторное нажатие удаляет оценку; ставить их можно только за сегодня и прошедшие дни." : "Оценки доступны только в 📘 Дневнике школьного профиля. Переключитесь через Настройки → Профиль → Изменить.",
            diary: profile === "student" ? "📘 Дневник находится в боковом меню, а на телефоне — в нижнем меню. Выберите неделю и день с понедельника по субботу, затем откройте карточку предмета для оценки, домашнего задания или заметки." : "📘 Дневник доступен только в школьном профиле. Переключитесь через Настройки → Профиль → Изменить, чтобы увидеть Дневник и Уроки.",
            event: "Добавьте событие в разделе «План» или кнопкой «+» внизу справа. Заполните название, дату и время начала/окончания, затем сохраните; событие можно изменить или удалить, а при пересечении времени оно не сохранится.",
            breakTime: "В школьном профиле откройте «Уроки», измените время уроков и перемены в полях внизу страницы и сохраните. Стандартная большая перемена — 10:15–10:30; в Дневнике также отображаются текущее время и статус урока.",
            schedule: "Откройте «Уроки». Измените предметы кнопкой «Изменить», а время уроков и перемены — в полях внизу страницы, затем сохраните. Стандартные уроки начинаются в 08:00 и длятся 45 минут.",
            taskFilter: "В разделе «Задачи» выберите фильтр «Все», «Не выполнено» или «Выполнено». Найдите задачу по названию через поле поиска.",
            taskDone: "В разделе «Задачи» отметьте флажок рядом с выполненной задачей. Она появится среди выполненных; повторное нажатие вернёт её в активные.",
            taskAdd: "Нажмите «+ Добавить задачу» в разделе «Задачи» или кнопку «+» внизу справа. Укажите название, срок и приоритет; при желании добавьте категорию и подзадачи через запятую, затем сохраните.",
            personalData: "Я не вижу ваши личные задачи, планы или оценки: они хранятся в браузере. План на сегодня смотрите на главной странице, задачи — в «Задачах», события — в календаре или плане.",
            serverRun: "API-ключ не нужен. В папке проекта запустите `node server.js`, затем откройте http://localhost:3000; требуется Node.js 18 или новее.",
            habitStreak: "Отмечайте выполненные дни на тепловой карте в разделе «Привычки». Серия показывает количество дней подряд; нажмите на клетку дня, чтобы изменить уровень выполнения.",
            habit: "В разделе «Привычки» нажмите «Создать привычку» и укажите название, эмодзи и цвет. Нажатия на клетку карты циклически меняют уровень 1→2→3→4→0; выберите «Весь год» или «Сентябрь–сегодня».",
            focus: "В разделе «Фокус» используйте кнопки «Старт», «Пауза» и «Сброс» для таймера 25 минут работы и 5 минут отдыха. Измените длительность в настройках таймера; история показывает последние 6 сессий.",
            calendar: "В разделе «Календарь» выберите месяц, неделю или день. Переключайте период кнопками ‹ и ›; нажатие на дату показывает события и задачи этого дня.",
            calculator: "В калькуляторе доступны обычный, научный, процентный режимы и разница времени; в школьном профиле есть средняя оценка. В научном режиме выберите DEG/RAD; Enter считает, Backspace удаляет, Esc очищает.",
            stats: "В разделе «Статистика» показаны выполнение задач и привычек, серии, лучший день, время фокуса и категории. В школьном профиле также доступен график оценок.",
            language: "Откройте Настройки и выберите «Русский», «O‘zbekcha» или English в разделе языка. Выбор сохраняется в браузере.",
            theme: "Переключайте светлую и тёмную тему кнопкой ◐ вверху справа; выбор сохранится.",
            notifications: "Включите уведомления в Настройках и разрешите их в браузере. Напоминание появляется за 5 минут до события только пока страница открыта.",
            export: "Откройте Настройки и нажмите экспорт JSON; резервный файл загрузится через браузер. Данные не отправляются автоматически на сервер.",
            import: "В Настройках выберите импорт JSON и загрузите ранее экспортированную копию Kunora. Перед импортом сохраните отдельную резервную копию важных данных.",
            clear: "В Настройках выберите «Очистить все данные» и подтвердите действие. Это удалит данные Kunora из браузера; сначала рекомендуется экспортировать JSON-копию.",
            storage: "Данные Kunora хранятся в localStorage этого браузера и устройства — вход и сервер для хранения не нужны. Для переноса на другое устройство используйте экспорт/импорт JSON в Настройках.",
            quickAdd: "Кнопка «+» внизу справа добавляет элемент в зависимости от открытого раздела: событие на обычной странице, задачу в «Задачах» или привычку в «Привычках».",
            section: "На компьютере разделы находятся в боковом меню, на телефоне — в нижнем. Напишите, какой раздел ищете, например Дневник, Задачи, Фокус или Настройки."
        },
        en: {
            profile: "Change profiles via Settings → Profile → Edit. The School profile includes the timetable and grades; My Everyday Life is for personal planning. Switching profiles does not delete your data.",
            homework: "In 📘 Diary, choose a day and subject, then enter the Homework field. Press Add to Tasks to create a task using the subject and date; the same diary entry cannot be added twice.",
            grades: profile === "student" ? "Open 📘 Diary, choose a week and day, then tap 2, 3, 4, or 5 on a subject card. Tap the selected grade again to remove it; grades are available only for today and past days." : "Grades are available only in 📘 Diary in the School profile. Switch via Settings → Profile → Edit.",
            diary: profile === "student" ? "📘 Diary is in the side menu on desktop and the bottom menu on phones. Choose a week and a Monday–Saturday day, then open a subject card to enter a grade, homework, or note." : "📘 Diary is available only in the School profile. Switch via Settings → Profile → Edit to see Diary and Lessons.",
            event: "Add an event from Plan or with the lower-right “+” button. Enter its name, date, start and end times, then save; you can edit or delete events, and overlapping times are rejected.",
            breakTime: "In the School profile, open Lessons, edit lesson and break times in the fields at the bottom, and save. The default long break is 10:15–10:30; Diary also shows the live clock and lesson status.",
            schedule: "Open Lessons. Use Edit to change subject names, and update lesson and break times in the fields at the bottom, then save. Standard lessons start at 08:00 and last 45 minutes.",
            taskFilter: "In Tasks, choose All, Open, or Completed. Use the search field to find a task by name.",
            taskDone: "In Tasks, tick the checkbox next to a finished item. It moves to Completed; click again to mark it open.",
            taskAdd: "Choose “+ Add task” in Tasks or use the lower-right “+” button. Enter a name, due date, and priority; optionally add a category and comma-separated subtasks, then save.",
            personalData: "I cannot see your personal tasks, plans, or grades because they are stored in your browser. Check today's plan on Home, tasks in Tasks, and events in Calendar or Plan.",
            serverRun: "No API key is needed. From the project folder, run `node server.js`, then open http://localhost:3000. Node.js 18 or newer is required.",
            habitStreak: "Mark completed days on the heatmap in Habits. A streak counts consecutive days; click a day cell to change its completion level.",
            habit: "In Habits, choose Create Habit and enter a name, emoji, and color. Heatmap cells cycle through levels 1→2→3→4→0; choose Full Year or September–Today.",
            focus: "In Focus, use Start, Pause, and Reset for the 25-minute work and 5-minute break timer. Change durations in timer settings; the history keeps the last 6 sessions.",
            calendar: "In Calendar, choose Month, Week, or Day. Use ‹ and › to change the period; selecting a date shows that day's events and tasks.",
            calculator: "The Calculator offers Standard, Scientific, Percent, and Time Difference modes; Grade Average is available in the School profile. Choose DEG/RAD in Scientific mode; Enter calculates, Backspace deletes, and Esc clears.",
            stats: "Statistics shows task and habit completion, streaks, best day, focus time, and categories. The School profile also includes a grade chart.",
            language: "Open Settings and select English, O‘zbekcha, or Русский under Language. Your choice is saved in the browser.",
            theme: "Use the ◐ button in the upper-right corner to switch between light and dark themes; your choice is saved.",
            notifications: "Enable notifications in Settings and grant browser permission. Reminders appear 5 minutes before an event only while the page is open.",
            export: "Open Settings and choose JSON Export; the backup downloads through your browser. Your data is not automatically sent to a server.",
            import: "In Settings, choose JSON Import and select a previously exported Kunora backup. Save a separate copy of important data before importing.",
            clear: "In Settings, choose Clear All Data and confirm. This deletes Kunora data stored in this browser; exporting a JSON backup first is recommended.",
            storage: "Kunora saves data in localStorage in this browser on this device; no account or server is needed for storage. Use JSON export/import in Settings to move data to another device.",
            quickAdd: "The lower-right “+” button adds an item for the current section: an event on a regular page, a task in Tasks, or a habit in Habits.",
            section: "Sections are in the left menu on desktop and the bottom menu on phones. Tell me which one you need, such as Diary, Tasks, Focus, or Settings."
        }
    };
    if (intent) return replies[lang][intent];
    return {
        uz: "Men Kunora bo‘yicha yordam beraman: bo‘limlar, tadbirlar, vazifalar, odatlar, Kundalik, dars jadvali, Fokus, Kalendar, Kalkulyator va Sozlamalar haqida so‘rashingiz mumkin.",
        ru: "Я помогаю с Kunora: спрашивайте о разделах, событиях, задачах, привычках, Дневнике, расписании, Фокусе, Календаре, калькуляторе и настройках.",
        en: "I can help with Kunora: ask about sections, events, tasks, habits, Diary, the timetable, Focus, Calendar, Calculator, or Settings."
    }[lang];
}

function detectResponseLanguage(message, fallback) {
    const text = message.toLocaleLowerCase();
    if (/[а-яё]/i.test(text)) return "ru";
    if (/\b(how|where|what|when|which|can|add|open|export|task|grade|diary|settings|habit|focus|calendar|event|backup|theme|language|homework)\b/i.test(text)) return "en";
    if (/(\bo['’ʻ`]|g['’ʻ`]|(?:\bqanday|\bqayer|\bbah[oó]|\bvazifa|\bkundalik|\bodat|\bdars|\bsozlama|\beksport|\btadbir|\bkalendar|\bfokus|\bkalkulyator|\bbildirish)\w*)/i.test(text)) return "uz";
    return fallback;
}

function takeRateLimit(ip) {
    const now = Date.now();
    let bucket = rateBuckets.get(ip);
    if (!bucket || now - bucket.startedAt >= RATE_WINDOW) {
        bucket = { startedAt: now, count: 0 };
        rateBuckets.set(ip, bucket);
    }
    bucket.count += 1;
    return bucket.count <= RATE_LIMIT;
}

function cleanupRateBuckets() {
    const now = Date.now();
    for (const [key, value] of rateBuckets) {
        if (now - value.startedAt >= RATE_WINDOW) rateBuckets.delete(key);
    }
    for (const [key, sentAt] of sentSmsKeys) {
        if (now - sentAt >= 48 * 60 * 60 * 1000) sentSmsKeys.delete(key);
    }
}

function requestIp(req) {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim().slice(0, 100);
    return req.socket.remoteAddress || "unknown";
}

function requestOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return null;
    if (ALLOWED_ORIGIN) return origin === ALLOWED_ORIGIN ? origin : false;
    const protocol = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
    const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
    return origin === `${protocol}://${String(host).split(",")[0].trim()}` ? origin : false;
}

function withinDailyLimit() {
    const today = new Date().toISOString().slice(0, 10);
    if (dailyBucket.date !== today) dailyBucket = { date: today, count: 0 };
    if (dailyBucket.count >= DAILY_LIMIT) return false;
    dailyBucket.count += 1;
    return true;
}

function hasValidSmsKey(value) {
    if (SMS_CLIENT_KEY.length < 32 || typeof value !== "string") return false;
    const expected = Buffer.from(SMS_CLIENT_KEY);
    const actual = Buffer.from(value);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function getEskizToken(forceRefresh = false) {
    if (!forceRefresh && eskizToken && Date.now() - eskizTokenAt < 20 * 24 * 60 * 60 * 1000) return eskizToken;
    const body = new URLSearchParams({ email: ESKIZ_EMAIL, password: ESKIZ_PASSWORD });
    const response = await fetch("https://notify.eskiz.uz/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(10000)
    });
    const result = await response.json();
    const token = result?.data?.token;
    if (!response.ok || typeof token !== "string" || !token) throw new Error("Eskiz login failed");
    eskizToken = token;
    eskizTokenAt = Date.now();
    return eskizToken;
}

async function sendEskizSms(phone, message) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const token = await getEskizToken(attempt > 0);
        const body = new FormData();
        body.set("mobile_phone", phone);
        body.set("message", message);
        body.set("from", ESKIZ_FROM);
        const response = await fetch("https://notify.eskiz.uz/api/message/sms/send", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body,
            signal: AbortSignal.timeout(10000)
        });
        if (response.status === 401 && attempt === 0) {
            eskizToken = "";
            continue;
        }
        if (!response.ok) throw new Error(`Eskiz SMS request failed (${response.status})`);
        return;
    }
    throw new Error("Eskiz authorization failed");
}

async function handleSms(req, res) {
    if (SMS_CLIENT_KEY.length < 32 || !ESKIZ_EMAIL || !ESKIZ_PASSWORD) {
        sendJson(res, 503, { error: "SMS service is not configured" });
        return;
    }
    if (!hasValidSmsKey(req.headers.authorization?.replace(/^Bearer\s+/i, ""))) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
    }
    if (!takeRateLimit(requestIp(req)) || !withinDailyLimit()) {
        sendJson(res, 429, { error: "SMS request limit reached" });
        return;
    }
    const body = await readJsonBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        typeof body.key !== "string" || !/^[a-zA-Z0-9:_-]{1,160}$/.test(body.key) ||
        typeof body.phone !== "string" || !/^998\d{9}$/.test(body.phone) ||
        typeof body.name !== "string" || !body.name.trim() || body.name.length > 200 ||
        typeof body.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
        sendJson(res, 400, { error: "Invalid SMS request" });
        return;
    }
    const previous = sentSmsKeys.get(body.key);
    if (previous && Date.now() - previous < 48 * 60 * 60 * 1000) {
        sendJson(res, 200, { sent: true, duplicate: true });
        return;
    }
    if (pendingSmsKeys.has(body.key)) {
        sendJson(res, 409, { error: "SMS request is already being processed" });
        return;
    }
    pendingSmsKeys.add(body.key);
    try {
        const message = `Kunora eslatma: ${body.name.trim()} (${body.date})`.slice(0, 250);
        await sendEskizSms(body.phone, message);
        sentSmsKeys.set(body.key, Date.now());
        sendJson(res, 200, { sent: true });
    } finally {
        pendingSmsKeys.delete(body.key);
    }
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        const declaredLength = Number(req.headers["content-length"] || 0);
        if (declaredLength > MAX_BODY) {
            reject(Object.assign(new Error("Request body too large"), { status: 413 }));
            req.resume();
            return;
        }
        const chunks = [];
        let received = 0;
        let tooLarge = false;
        req.on("data", chunk => {
            if (tooLarge) return;
            received += chunk.length;
            if (received > MAX_BODY) {
                tooLarge = true;
                reject(Object.assign(new Error("Request body too large"), { status: 413 }));
                req.resume();
            } else chunks.push(chunk);
        });
        req.on("end", () => {
            if (tooLarge) return;
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
                reject(Object.assign(new Error("Invalid JSON"), { status: 400 }));
            }
        });
        req.on("error", reject);
    });
}

function validateHistory(history) {
    if (history === undefined) return [];
    if (!Array.isArray(history) || history.length > 8) throw Object.assign(new Error("Invalid history"), { status: 400 });
    if (history.some((item, index) =>
        !item || typeof item !== "object" ||
        !["user", "assistant"].includes(item.role) ||
        typeof item.content !== "string" ||
        item.content.length > MAX_MESSAGE ||
        item.role !== (index % 2 === 0 ? "user" : "assistant")
    )) {
        throw Object.assign(new Error("Invalid history"), { status: 400 });
    }
    let normalized = history.slice(-MAX_HISTORY);
    if (normalized[0]?.role === "assistant") normalized = normalized.slice(1);
    if (normalized.at(-1)?.role === "user") normalized = normalized.slice(0, -1);
    return normalized;
}

async function handleChat(req, res) {
    if (!takeRateLimit(requestIp(req))) {
        sendJson(res, 429, { error: "Too many requests" });
        return;
    }
    const body = await readJsonBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        typeof body.message !== "string" ||
        body.message.trim().length === 0 ||
        body.message.length > MAX_MESSAGE ||
        !LANGUAGES.has(body.lang)) {
        sendJson(res, 400, { error: "Invalid request" });
        return;
    }

    if (!withinDailyLimit()) {
        sendJson(res, 429, { error: "Daily request limit reached" });
        return;
    }
    validateHistory(body.history);
    const message = body.message.trim();
    const smallTalk = detectSmallTalk(message);
    if (smallTalk) {
        sendJson(res, 200, { reply: greetingReplies[smallTalk[0]][smallTalk[1]] });
        return;
    }

    const profile = body.profile === "student" ? "student" : "life";
    const replyLanguage = detectResponseLanguage(message, body.lang);
    sendJson(res, 200, { reply: knownHelpReply(message, replyLanguage, profile) });
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const origin = requestOrigin(req);
    if (origin === false) {
        res.writeHead(403, { "Cache-Control": "no-store", "Vary": "Origin" });
        res.end();
        return;
    }
    if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
    }
    if (["/api/chat", "/api/sms"].includes(url.pathname) && req.method === "OPTIONS") {
        if (req.headers.origin && !origin) {
            res.writeHead(403, { "Cache-Control": "no-store" });
            res.end();
            return;
        }
        res.writeHead(204, {
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Vary": "Origin"
        });
        res.end();
        return;
    }
    if (url.pathname === "/api/chat" && req.method === "POST") {
        try {
            await handleChat(req, res);
        } catch (error) {
            if (!res.headersSent && !res.destroyed) {
                const status = Number.isInteger(error.status) ? error.status : 500;
                if (status === 500) console.error("Chat endpoint error:", error);
                sendJson(res, status, { error: status === 500 ? "Internal server error" : error.message });
            }
        }
        return;
    }
    if (url.pathname === "/api/sms" && req.method === "POST") {
        try {
            await handleSms(req, res);
        } catch (error) {
            if (!res.headersSent && !res.destroyed) {
                const status = Number.isInteger(error.status) ? error.status : 502;
                if (status >= 500) console.error("SMS endpoint error:", error);
                sendJson(res, status, { error: status >= 500 ? "SMS sending failed" : error.message });
            }
        }
        return;
    }
    if ((url.pathname === "/" || url.pathname === "/index.html") && req.method === "GET") {
        res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff"
        });
        fs.createReadStream(path.join(ROOT, "index.html")).pipe(res);
        return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
});

server.listen(PORT, () => {
    console.log(`Kunora is running at http://localhost:${PORT}`);
});

const rateCleanup = setInterval(cleanupRateBuckets, RATE_WINDOW);
rateCleanup.unref();
