# ملخص تسليم — لكتابة System Design كامل لمشروع Academic Hub

**الغرض من هذه الوثيقة:** ملخص لكل القرارات المعمارية والسياق المتراكم من جلسة تحليل سابقة، مُعَدّ ليُسلَّم لنموذج آخر لكتابة وثيقة System Design نهائية وكاملة. كل قرار هنا مُعلَّل — لا تعيد فتح نقاش منتهٍ بلا سبب جديد.

---

## 1. السياق

- المطور: مطور منفرد (طالب طب، دوام جزئي، بلا فريق، بلا موعد إطلاق صارم، مستعد يتعلم أي تقنية)
- المشروع: Academic Hub — منصة SaaS متعددة الجامعات (Multi-tenant) للجامعات السودانية، تغطي الدورة الأكاديمية والمالية الكاملة للطالب
- يوجد **BRD.md ناضج** (١٨ قسماً، ٥٠ قراراً مصدَّقاً، ١٥ وحدة وظيفية SC-IN-01 إلى SC-IN-15) — هذا المصدر الأساسي لكل متطلب وظيفي، يُفترض توفره للنموذج المستقبِل
- Frontend منفصل عن هذا النقاش: Flutter (Riverpod + Hive) للمحاضر والطالب، تطبيق ويب للإداري — **خارج نطاق هذا الملخص**
- Hosting: خادم VPS من مزود سوداني محلي (cloud.sudani.sd) — **2 vCPU / 4GB RAM / 100GB SSD**، قابل للتوسعة، التزام تعاقدي بالاستضافة داخل السودان حصراً (NFR-HOST-001 في BRD)

---

## 2. القرارات المعمارية المحسومة (لا تُعاد مناقشتها بلا سبب)

### 2.1 نمط البنية العام
- **Modular Monolith** لا Microservices — نشر واحد، ١٥ وحدة كمجلدات/Modules منفصلة بحدود صارمة
- Backend: **NestJS + TypeScript** (أسباب الاختيار: يفرض حدود الوحدات بنيوياً عبر DI، أقرب تقنياً لخلفية المطور في Dart/Flutter، أدوات رسمية جاهزة BullMQ/WebSockets/Guards تطابق الاحتياج، استُبعد Express لغياب البنية، Laravel لضعف الـTyping مع آلات الحالات الحرجة، Go/Rust لطول وقت التطوير بلا DI/Modules جاهزة رغم كفاءة أعلى في الموارد، Elixir رغم ملاءمته النظرية (Actor Model) لصغر إيكوسيستمه، Spring Boot/Java لثقل JVM على خادم 4GB
- **قاعدة حديدية:** لا وحدة تستدعي repository وحدة أخرى مباشرة — فقط عبر Facade مُصدَّرة أو عبر حدث. تُفرض بـ`dependency-cruiser` في CI

### 2.2 قاعدة البيانات
- **PostgreSQL** (ليس SQLite — قفل كتابة لعميل واحد غير مناسب لحمل متوازٍ؛ ليس MySQL — يخسر `LISTEN/NOTIFY` وCHECK Constraints صارمة مطلوبة لآلات الحالات؛ ليس MongoDB — يتعارض مع العلاقات الصارمة وACID المطلوبة)
- **محتاج ضبطاً يدوياً صريحاً** للعمل بخفة على 4GB، ليس افتراضياً:
  ```
  shared_buffers = 512MB
  max_connections = 40
  work_mem = 4MB
  ```
- **PgBouncer إلزامي** بين NestJS وPostgres — يجمّع الاتصالات بدل ما كل طلب API يفتح اتصالاً مباشراً، وهذا الفرق الحقيقي بين Postgres "ثقيل" و"خفيف" على خادم صغير

### 2.3 Redis — ثلاثة أدوار معاً، ليس دوراً واحداً
هذه نقطة صُحِّحت أثناء الجلسة ويجب إدراجها بوضوح في النسخة النهائية:
1. **طوابير المهام** (BullMQ) للـWorker
2. **Pub/Sub** لتوزيع رسائل WebSocket (يجهّز لتعدد نسخ API لاحقاً)
3. **طبقة كاش (Cache-Aside)** — **ليست عامة فوق كل البيانات**، بل محدَّدة بوعي:

| يُكاش | لا يُكاش |
|---|---|
| جدول المحاضرات/الدفعة | حالة معاملة مالية قيد المراجعة |
| الإعلانات العامة | حالة جلسة امتحان حية |
| قائمة ملفات مستودع المادة | حالة حضور لحظية |
| النتائج المنشورة (بعد النشر تصير شبه ثابتة) | — |
| بنك الأسئلة (تصفح المحاضر، ليس وقت الامتحان) | — |


- **إبطال الكاش (Invalidation) مربوط بنفس Event Bus**، لا بـTTL عشوائي فقط — مثال: حدث `GradesPublished` يمسح مفتاح الكاش المرتبط مباشرة، فالتحديث فوري لحظة الحدث الحقيقي، والـTTL يبقى شبكة أمان ثانوية فقط
- حد ذاكرة صريح: `maxmemory 150mb`, `maxmemory-policy allkeys-lru` — لأن Redis يتشارك نفس الـ4GB مع Postgres والـAPI

### 2.4 تخزين الملفات
- **MinIO ذاتي الاستضافة** — ليس Cloudflare R2. R2 خدمة خارجية تتعارض مباشرة مع NFR-HOST-001 (حظر تخزين بيانات شخصية خارج السودان). هذا تصحيح عن قرار سابق كان يفترض R2 — **يحتاج تسجيلاً رسمياً في BRD** إن لم يكن مسجلاً بعد
- واجهة MinIO متوافقة مع S3 API، فالكود المكتوب بافتراض R2 ينتقل بتعديل طفيف

### 2.5 نمط الأحداث (Event Bus + Transactional Outbox)
- كل تغيير حالة مهم يُكتب مع حدثه في **نفس معاملة قاعدة البيانات** (جدول `events_outbox`) — يضمن ألا يضيع الحدث لو سقط الخادم بين الخطوتين
- عملية خلفية (Worker) تقرأ الـOutbox دورياً (أو عبر `LISTEN/NOTIFY`) وتوزّع الحدث على الوحدات المستمعة — ضمان **At-Least-Once Delivery**، لذلك كل معالج حدث يجب أن يكون Idempotent
- **وحدة الإشعارات (NOT) هي الوحيدة** المسموح لها الاستماع لكل الأحداث بلا استثناء؛ أي وحدة أخرى تستمع فقط لأحداث محددة صراحة في حدودها

### 2.6 آلات الحالات الصريحة (State Machines)
خمس آلات حرجة، كل واحدة بدالة `transition()` موحّدة تتحقق من الانتقالات المسموحة + الشروط المسبقة + تسجيل تلقائي في `audit_log`:
1. دورة حياة الفصل الدراسي (IDLE → PREPARATION → IN_PROGRESS → RESULTS)
2. المعاملة المالية (مبدئي → مراجعة نهائية ثلاثية → قبول/رفض)
3. جلسة الامتحان
4. جلسة الحضور
5. حالة الغش (رصد → تحذير/إحالة → قرار)

**لا تحديث مباشر على عمود الحالة في أي مكان بالكود خارج هذه الدالة.**

### 2.7 العمليات الخلفية (Worker Process)
عملية منفصلة من نفس الكود (وضع تشغيل مختلف، ليست خدمة مستقلة)، تتولى: التسليم التلقائي لنهاية الامتحان (**مرجع الوقت هو الخادم لا جهاز الطالب** — يحل مشكلة OS Timer Throttling)، طابور تصحيح الذكاء الاصطناعي (Retry×3 + Timeout + تحويل للبديل اليدوي عند الفشل)، بناء الأرشيف المشفّر لنهاية الفصل، الاستيراد الجماعي، توليد PDF/Excel، التذكير المالي التلقائي، الأرشفة الدورية، التنظيف الدوري

### 2.8 القنوات اللحظية (WebSocket)
ثلاث قنوات ضمن نفس عملية API (Namespaces منفصلة) + Redis Pub/Sub كطبقة توزيع: `/ws/proctor` (بوابة المراقب، ويب فقط)، `/ws/chat`، `/ws/notifications`. نفس TenantGuard وRoleGuard المستخدمين في REST يُطبَّقان هنا أيضاً

### 2.9 العمل دون اتصال (Idempotency Contract)
ثلاثة مسارات فقط تحتاجه: رفع قوائم الحضور، الحفظ التلقائي لإجابات الامتحان، أحداث الغش. العقد: `Idempotency-Key` (UUID يولّده العميل وقت حدوث الفعل محلياً، لا وقت الإرسال) + نافذة Dedup 48 ساعة على الخادم. يحل مشكلة فقدان البيانات أثناء انقطاع الاتصال معمارياً لا بإعادة محاولة ساذجة

---

## 3. بنية النشر (خادم واحد)

Docker Compose: `nginx` (TLS + reverse proxy) ← `api` (NestJS) + `worker` (نفس الصورة) ← `postgres` + `redis` + `minio`. تخصيص ذاكرة تقريبي على 4GB: Postgres ~1.2GB، API ~500-700MB، Worker ~300-500MB، Redis ~200-350MB (بعد إضافة دور الكاش)، MinIO ~300MB، النظام ~500MB — **هامش ضيق، يحتاج مراقبة فعلية من أول أسبوع تطوير لا بعد الإطلاق**

**نسخ احتياطي:** Postgres يومياً (pg_dump + WAL)، MinIO أسبوعياً، لموقع ثانٍ داخل السودان

---

## 4. تحذيرات ومخاطر يجب أن تظهر صراحة في النسخة النهائية

1. **خادم واحد = نقطة فشل وحيدة**، يتعارض مع هدف 99.9% توافر داخل نوافذ الامتحانات في BRD (RSK-03). هذا تصميم "ابنِ بكفاءة على خادم واحد"، **لا** حل لمشكلة التوافر نفسها — القرار معلّق على OI-05 (مزود استضافة أفضل) في BRD، مستقل عن اختيار التقنية
2. البنية الحالية **لا تحل** مشكلة التوافر، بل تبني فوق القيد الواقعي مؤقتاً
3. تناقض محتمل موجود فعلاً في BRD يحتاج تصحيحاً: FR-SET-011 يبقي زر "طلب تعديل بيانات" يُرسل للإداري، لكن القرار ٢٥ حذف الإشعار المرتبط (SA-05) نهائياً — يحتاج قراراً صريحاً (حذف الزر أو استحداث إشعار بديل)

---

## 5. حدود الوحدات الـ15 (خريطة الملكية)

| الوحدة | الكود | أهم الجداول | يستمع لأحداث من |
|---|---|---|---|
| النواة المشتركة | KRN | institutions, users, audit_log, events_outbox, files | — (أفقية) |
| الهوية والوصول | AUTH | sessions, devices, permission_templates | — |
| المستأجرون والفوترة | OWN | subscriptions, billing_counters | StudentActivated/Deactivated |
| الأكاديمية | ADM | programs, cohorts, students, lecturers, semester_states | DocumentVerified |
| المنشآت والجداول | FAC | facilities, bookings, schedule_conflicts | LecturerAssigned |
| الحضور | ATT | attendance_sessions, attendance_records, violations | ScheduleConfirmed |
| الامتحانات | EXM | question_bank, exam_sessions, submissions | WeightsFinalized |
| التصحيح | CHT | grading_queue, ai_grading_results | ExamSubmitted |
| مكافحة الغش | PRC | cheating_events, cheating_cases | ExamSessionStarted |
| الدرجات والنتائج | GRD | coursework, final_grades, transcripts | ExamGraded, AttendanceFinalized |
| المالية | PAY | transactions, payment_reviews | StudentEnrolled |
| التواصل | CHA | chats, support_tickets, subject_channels | — |
| الملفات | FIL | files (من KRN) + file_links | — |
| الإشعارات | NOT | notifications, notification_preferences | **كل الأحداث** |
| لوحة القيادة/الإعدادات | DSH/SET | (Views فقط) | — |

---

## 6. نطاق MVP (محسوم بمنطق، وليس بترتيب القيمة)

**المعيار المعتمد:** أصغر مجموعة وحدات تُكمِّل دورة فصل دراسي كاملة قابلة للاختبار الحقيقي على جامعة تجريبية واحدة (OI-02 في BRD) — لا ترتيب "الأعلى قيمة" وحده، لأن بعض الوحدات عالية القيمة (مالية، امتحانات) لا تعمل بلا بنية تحتية منخفضة القيمة المُدركة (مصادقة، إدارة أكاديمية).. المنشأت و الجداول

**داخل MVP:** المصادقة، الإدارة الأكاديمية، المالية، الحضور، الامتحانات، مكافحة الغش (نسخة أساسية: رصد + قائمة مراجعة بلا بوابة مراقب كاملة)، الملفات والنتائج، الإشعارات (نسخة أساسية)، الإعدادات (نسخة أساسية)

**v1.1 (بعد MVP مباشرة):*التصحيح بالذكاء الاصطناعي،  الكاملة (اقتراح آلي + كشف تعارض)، التواصل، لوحة القيادة الكاملة

**بنية توسع لاحقة (ليس للتجربة الأولى):** تعدد الجامعات (لوحة المالك الكاملة)، الاستيراد الجماعي

**تقدير زمني تقريبي (دوام جزئي، غير ملزم، يُعدَّل بعد أول وحدتين فعليتين):** ~24-30 أسبوعاً لكامل MVP (الامتحانات أثقل وحدة منفردة: 4.5-5.5 أسابيع)

---

## 7. مطلوب من النموذج المستقبِل

اكتب System Design كاملاً ونهائياً يدمج كل ما سبق، مع:
- تفصيل كامل لمخطط قاعدة البيانات (الجداول + العلاقات) لكل وحدة، مبني على FR الكاملة في BRD.md
- تفصيل كود فعلي أعمق لآلات الحالات الخمس وعقد الـIdempotency
- إضافة قسم الكاش والـPostgres tuning بالتفصيل الكامل (غير موجودين في المسودة الأولى، أُضيفا لاحقاً في هذا الملخص فقط)
- اقتراح استراتيجية اختبار (Unit/Integration) تلائم مطوراً منفرداً
- لا تعد فتح أي قرار من القسم 2 أعلاه بلا سبب تقني جديد لم يُذكر هنا


Cache Distribution and Logical Isolation Architecture

1. الهدف

يعتمد نظام UCS على طبقة Cache مركزية مشتركة، مع توفير عزل منطقي كامل بين الوحدات (Modules)، بحيث:

· لا تستطيع أي وحدة قراءة أو تعديل بيانات Cache مملوكة لوحدة أخرى.
· لا يتم إنشاء Cache Infrastructure منفصلة لكل Module دون حاجة تشغيلية.
· يتم تحقيق العزل باستخدام Cache Key Namespace.
· توجد مساحة common مخصصة للبيانات المشتركة بين الوحدات.
· يتم عزل بيانات كل Tenant عن بقية الـTenants باستخدام tenant_id.
· تظل قاعدة البيانات المصدر الأساسي للحقيقة (Source of Truth)، بينما تستخدم الـCache لتحسين الأداء.

---

2. البنية العامة

يستخدم النظام Redis كطبقة Cache مشتركة بين جميع الوحدات:

```
                         UCS Backend
                              │
              ┌───────────────┼───────────────┐
              │               │               │
          Module A         Module B        Module C
              │               │               │
              └───────────────┼───────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │   Cache Layer    │
                    │      Redis       │
                    └──────────────────┘
                              │
                 ┌────────────┼────────────┐
                 │            │            │
                 ▼            ▼            ▼
              Module       Module       Common
               Keys         Keys         Keys
```

وجود Redis واحد لا يعني أن الوحدات تشترك في البيانات منطقيًا.
العزل يتم داخل Redis نفسه بواسطة Key Namespace.

---

3. مبدأ العزل

لا تعتمد UCS على إنشاء Redis مستقل لكل Module لتحقيق العزل.

بدلًا من ذلك، يتم إعطاء كل Module Namespace خاصًا داخل الـCache.

الصيغة الأساسية للـKey هي:

```
ucs:{tenant_id}:{module}:{resource}:{identifier}
```

مثال:

```
ucs:univ001:students:profile:123
ucs:univ001:courses:course:55
ucs:univ001:grades:result:123:55
ucs:univ001:library:book:982
```

وبذلك يصبح اسم الـModule جزءًا أساسيًا من هوية الـCache Entry.

---

4. عزل الوحدات

لكل Module مساحة Key خاصة بها.

مثال:

```
ucs:univ001:students:*
ucs:univ001:courses:*
ucs:univ001:grades:*
ucs:univ001:library:*
ucs:univ001:finance:*
```

كل Module مسؤولة فقط عن Keys الموجودة داخل Namespace الخاص بها.

مثلاً Module الطلاب يمكنها الوصول إلى:

```
ucs:univ001:students:profile:123
ucs:univ001:students:enrollment:123
ucs:univ001:students:status:123
```

ولا يُسمح لها بالوصول مباشرة إلى:

```
ucs:univ001:finance:invoice:789
ucs:univ001:grades:result:123:55
ucs:univ001:library:book:982
```

حتى وإن كانت هذه الـKeys موجودة داخل نفس Redis.

---

5. مساحة البيانات المشتركة

توجد Namespace خاصة باسم:

```
common
```

وتستخدم للبيانات التي تحتاج إليها عدة Modules.

الصيغة:

```
ucs:{tenant_id}:common:{resource}:{identifier}
```

أمثلة:

```
ucs:univ001:common:department:10
ucs:univ001:common:faculty:5
ucs:univ001:common:academic_year:2026
ucs:univ001:common:semester:1
ucs:univ001:common:settings
```

يمكن للوحدات المختلفة قراءة البيانات الموجودة في common عند الحاجة.

مثلاً:

```
Students Module
       │
       └──> common:department:10

Courses Module
       │
       └──> common:department:10

Grades Module
       │
       └──> common:department:10
```

وبذلك لا يتم تكرار نفس البيانات في Cache كل Module.

---

6. قواعد الوصول

يتم تطبيق قواعد الوصول التالية:

Module Cache

الوحدة:

```
Module X
```

تستطيع الوصول إلى:

```
ucs:{tenant}:X:*
```

ولا تستطيع الوصول مباشرة إلى:

```
ucs:{tenant}:Y:*
ucs:{tenant}:Z:*
```

Common Cache

يمكن للوحدات التي تحتاج بيانات مشتركة الوصول إلى:

```
ucs:{tenant}:common:*
```

Tenant Isolation

لا يمكن لـTenant الوصول إلى Cache تخص Tenant آخر.

مثلاً:

```
ucs:univ001:students:profile:123
```

منفصلة عن:

```
ucs:univ002:students:profile:123
```

حتى لو كان student_id متطابقًا.

---

7. نموذج الـKey الكامل

يستخدم UCS النموذج التالي:

```
ucs:{tenant_id}:{namespace}:{resource}:{identifier}
```

حيث:

الجزء الوظيفة
ucs تعريف النظام
tenant_id عزل بيانات المؤسسة
namespace تحديد الـModule أو common
resource نوع البيانات
identifier معرف العنصر

مثال:

```
ucs:univ001:students:profile:123
```

يُفسر كالتالي:

```
System     = UCS
Tenant     = univ001
Namespace  = students
Resource   = profile
Identifier = 123
```

---

8. أمثلة عملية

Students Module

```
ucs:univ001:students:profile:123
ucs:univ001:students:enrollment:123
ucs:univ001:students:academic_status:123
```

Courses Module

```
ucs:univ001:courses:course:55
ucs:univ001:courses:sections:55
ucs:univ001:courses:schedule:55
```

Grades Module

```
ucs:univ001:grades:result:123:55
ucs:univ001:grades:transcript:123
```

Finance Module

```
ucs:univ001:finance:invoice:789
ucs:univ001:finance:payment:456
```

Common

```
ucs:univ001:common:department:10
ucs:univ001:common:faculty:5
ucs:univ001:common:academic_year:2026
```

---

9. منع القراءة المباشرة بين الوحدات

العزل لا يعتمد فقط على تسمية الـKeys.

يجب أن يحتوي التطبيق على Cache Access Layer تمنع الـModules من التعامل المباشر مع Redis.

بدلًا من:

```python
redis.get("ucs:univ001:finance:invoice:789")
```

داخل Students Module، تستخدم الوحدة واجهة Cache الخاصة بها:

```python
students_cache.get_student(123)
```

والـCache Layer هي المسؤولة عن بناء الـKey الصحيح:

```
ucs:univ001:students:profile:123
```

وبالتالي لا تحتاج الوحدة إلى معرفة أو التعامل مع Namespace الوحدات الأخرى.

---

10. قاعدة ملكية الـCache

كل Cache Entry يجب أن يكون لها Module مالكة.

مثال:

```
ucs:univ001:students:profile:123
                ↑
             Owner:
            Students
```

و:

```
ucs:univ001:grades:result:123:55
                ↑
             Owner:
             Grades
```

أما:

```
ucs:univ001:common:department:10
                ↑
             Owner:
             Common
```

الـModule المالكة هي المسؤولة عن:

· إنشاء الـCache Entry.
· تحديثها.
· حذفها.
· تحديد TTL المناسب.
· تنفيذ Cache Invalidation عند تغير البيانات.

---

11. Cache Invalidation

عند تعديل البيانات في قاعدة البيانات، يجب إزالة الـCache المرتبطة بها.

مثال:

```
Student Update
      │
      ▼
PostgreSQL
      │
      ▼
DELETE
ucs:univ001:students:profile:123
```

وعند الطلب التالي:

```
GET student 123
      │
      ▼
Redis
      │
    MISS
      │
      ▼
PostgreSQL
      │
      ▼
Redis SET
      │
      ▼
Return
```

وبذلك لا تعتمد الـDatabase على Redis، وإنما Redis تعتمد على بيانات الـDatabase.

---

12. البيانات المشتركة وCache Invalidation

إذا تغيرت بيانات موجودة في common، يجب إبطال الـCache المشتركة التي تعتمد عليها.

مثال: Department 10

يتم تخزينها:

```
ucs:univ001:common:department:10
```

عند تعديل Department 10:

```
UPDATE common.department
          │
          ▼
DELETE
ucs:univ001:common:department:10
```

وعند الطلب التالي تقوم أي Module تحتاجها بإعادة تحميلها من قاعدة البيانات.

---

13. لا يوجد تكرار للبيانات المشتركة بدون حاجة

إذا كانت نفس البيانات تستخدمها عدة Modules، فلا يجب أن يكون هناك:

```
students:department:10
courses:department:10
grades:department:10
library:department:10
```

إذا كانت جميعها تمثل نفس المصدر.

بدلاً من ذلك:

```
common:department:10
```

وتستخدمه الوحدات المحتاجة.

هذا يقلل:

· Cache duplication
· Memory usage
· Inconsistency
· عدد عمليات التحديث
· تعقيد الـInvalidation

---

14. العلاقة بين Database Schema وCache Namespace

يجب عدم الخلط بين طبقة قاعدة البيانات وطبقة الـCache.

قاعدة البيانات

```
PostgreSQL
│
├── students schema
├── courses schema
├── grades schema
├── finance schema
└── common schema
```

الـCache

```
Redis
│
├── ucs:{tenant}:students:*
├── ucs:{tenant}:courses:*
├── ucs:{tenant}:grades:*
├── ucs:{tenant}:finance:*
└── ucs:{tenant}:common:*
```

وبالتالي:

· Database Schema Isolation يتم على مستوى الـSchema.
· Cache Logical Isolation يتم على مستوى الـKey Namespace.

لا يشترط أن يكون لكل Database Schema Redis Database أو Redis Instance مستقل.

---

15. قاعدة تصميم أساسية

يجب أن تلتزم جميع Cache Keys في UCS بالقاعدة التالية:

```
ucs:{tenant_id}:{namespace}:{resource}:{identifier}
```

ولا يسمح باستخدام Keys عامة مثل:

```
student:123
course:55
department:10
```

لأنها لا توفر عزلًا كافيًا بين الـTenants والـModules.

الصحيح:

```
ucs:univ001:students:profile:123
ucs:univ001:courses:course:55
ucs:univ001:common:department:10
```

---

16. النتيجة المعمارية

يعتمد UCS على:

```
                 ┌────────────────────────┐
                 │       Redis Cache      │
                 │      Shared Layer      │
                 └───────────┬────────────┘
                             │
       ┌─────────────────────┼─────────────────────┐
       │                     │                     │
       ▼                     ▼                     ▼
  Module Namespace      Module Namespace      Common Namespace
       │                     │                     │
  students:*             courses:*             common:*
  grades:*                finance:*             shared data
  library:*               auth:*
```

ويتم تحقيق العزل باستخدام:

```
Tenant ID
    +
Module Namespace
    +
Resource
    +
Identifier
```

وليس عن طريق إنشاء Redis منفصل لكل Module.

---

17. القاعدة النهائية

كل Module تملك Namespace خاصًا بها، ولا تقرأ أو تعدل Namespace الخاصة بالـModules الأخرى.

الـcommon Namespace هي الاستثناء المقصود، وتحتوي فقط على البيانات التي تم تصميمها لتكون مشتركة بين Modules.

وبذلك يكون:

```
Module → Module Cache
Module → Common Cache
```

مسموحًا حسب الحاجة، بينما:

```
Module A → Module B Cache
```

غير مسموح مباشرة.

هذا يحقق Logical Cache Isolation مع الحفاظ على Redis Infrastructure مشتركة وقابلة للتوسع.
