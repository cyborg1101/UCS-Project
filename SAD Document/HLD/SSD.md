# وثيقة تصميم النظام (System Design Document)
## Academic Hub: منصة الإدارة الجامعية المتكاملة متعددة الجامعات

---

## 0. ضبط الوثيقة

| البند | القيمة |
|---|---|
| الإصدار | SDD 1.0، مسودة للاعتماد |
| المراجع | BRD.md الإصدار 1.0، ملخص التسليم المعماري، وثيقة عزل الكاش المنطقي |
| النطاق | الخادم الخلفي (Backend) والبنية التحتية والبيانات. الواجهات (Flutter والويب) خارج نطاق الوثيقة إلا حيث يلزم تحديد العقد بينها وبين الخادم |
| الجمهور | المطور المنفرد، وأي مراجع تقني لاحق |

### 0.1 ملاحظة مهمة عن المصادر

حاولت قراءة BRD.md كاملاً، لكن أدوات قراءة الملفات لم تصل إلا إلى بدايته: الأقسام من 0 إلى 5 كاملة، والقسم 6 حتى المتطلب FR-ADM-043 تقريباً. باقي الوثيقة لم يصلني، وهو يشمل متطلبات FAC وATT وEXM وPRC وPAY وCHA وFIL وNOT وSET وDSH، والمتطلبات غير الوظيفية، وقائمة القرارات الخمسين، وسجل المسائل المفتوحة. لهذا اتبعت قاعدة واحدة في كل الوثيقة: أي تفصيل لم أستطع التحقق منه في الجزء الذي قرأته موسوم بـ **[افتراض‑SD]**، ويجب مطابقته مع BRD قبل كتابة الـ migration الخاص به. أهم هذه التفاصيل: الأنواع الستة للأسئلة، وأحداث الغش الخمسة، والفئات الست للملفات، ومعنى المراحل الثلاث للمراجعة المالية، وأقسام الإعدادات العشرة. صممت المخطط بحيث تبقى هذه القيم بيانات أو enum قابلاً للتعديل، فلا يتغير الهيكل حين تتغير.

### 0.2 اصطلاحات الوثيقة

**[محسوم]** قرار من الملخص لا يُعاد فتحه. **[جديد‑ADR]** قرار جديد أو تصحيح مبني على سبب تقني لم يرد في الملخص، ومعلل في القسم 3. **[افتراض‑SD]** تفصيل يحتاج مطابقة مع BRD.

---

## 1. الملخص المعماري

Academic Hub نظام Modular Monolith مكتوب بـ NestJS وTypeScript، يُنشر على خادم VPS واحد داخل السودان (2 vCPU، 4GB RAM، 100GB SSD) باستخدام Docker Compose. الكود واحد ويعمل بوضعين: `api` يخدم REST وWebSocket، و`worker` ينفذ المهام الخلفية وينشر الأحداث. مصدر الحقيقة الوحيد قاعدة PostgreSQL، وأمامها PgBouncer لتجميع الاتصالات. بيانات كل جامعة معزولة بثلاث طبقات: عمود `tenant_id` في كل جدول، ومفاتيح أجنبية مركبة تمنع الإشارة عبر الجامعات، وسياسات Row Level Security في قاعدة البيانات نفسها. كل وحدة من الوحدات الخمس عشرة تملك Schema خاصاً في Postgres وNamespace خاصاً في الكاش، ولا تتواصل مع غيرها إلا عبر Facade مُصدَّرة أو عبر حدث يمر من Transactional Outbox. الحالات الحرجة الخمس تُدار بآلات حالات صريحة يحميها trigger في قاعدة البيانات، فلا يمكن تجاوزها حتى بخطأ برمجي. المسارات الثلاثة التي تعمل دون اتصال تخضع لعقد Idempotency موحد.

ما لا يفعله هذا التصميم يجب أن يكون واضحاً من البداية: هو لا يحل مشكلة التوافر. خادم واحد يعني نقطة فشل واحدة، وهذا يتعارض مع هدف 99.9% في نوافذ الامتحانات (RSK-03). التصميم يبني بكفاءة فوق القيد الحالي، ويجعل الانتقال لاحقاً إلى أكثر من خادم تغييراً في النشر لا في الكود (القسم 23).

---

## 2. المحركات المعمارية والقيود

| المحرك | المصدر | الأثر على التصميم |
|---|---|---|
| العزل الكامل بين الجامعات | FR-OWN-002، القرار (1) | RLS، ومفاتيح أجنبية مركبة، وبادئة tenant في مفاتيح الكاش، وTenantGuard على REST وWS |
| المالك لا يرى بيانات تشغيلية | FR-OWN-003 | مخطط `own` منفصل، يتغذى من أحداث مجمّعة فقط، ودور قاعدة بيانات منفصل للمالك |
| الاستضافة داخل السودان حصراً | NFR-HOST-001 | تخزين كائنات ذاتي الاستضافة، ونسخ احتياطي داخل السودان، وتدقيق كل خدمة خارجية (القسم 23) |
| Google Sign-In وسيلة الدخول الوحيدة | FR-AUTH-001 | التحقق من ID Token في الخادم، ثم إصدار رموز خاصة بالنظام |
| ربط الجهاز | FR-AUTH-017/018/019 | جدول devices، وفهرس جزئي يسمح بجهاز نشط واحد لكل مستخدم، وآلية موافقة |
| سجل تدقيق غير قابل للتعديل | FR-AUTH-023، FR-ADM-039 | جدول append-only مع trigger وسلسلة hash |
| الأرشيف المشفّر | FR-ADM-041/042/043 | مهمة worker، وتشفير AES-256، ومفتاح لكل أرشيف محفوظ بتشفير مغلّف |
| موارد محدودة (4GB) | الاستضافة | ضبط يدوي لـ Postgres وRedis، وPgBouncer، وميزانية ذاكرة صريحة |
| مطور منفرد بدوام جزئي | السياق | تقنيات قليلة ومجربة، وفرض الحدود آلياً في CI بدل الاعتماد على الانضباط الشخصي |
| الشبكة غير مستقرة | السياق السوداني | عقد Idempotency، وطابور محلي في العميل، ومرجع الوقت في الخادم |

---

## 3. قرارات جديدة وتصحيحات (ADRs)

القرارات في القسم 2 من الملخص بقيت كما هي. القرارات الخمسة التالية مبنية على أسباب تقنية جديدة لم ترد في الملخص.

### ADR‑N1: فصل Redis إلى نسختين **[جديد‑ADR، تصحيح لتعارض داخلي]**

**المشكلة.** الملخص يطلب Redis واحداً بثلاثة أدوار، ويضبطه على `maxmemory-policy allkeys-lru`. لكن وثائق BullMQ الرسمية ("Going to production") تشترط أن تكون السياسة `noeviction`، لأنها الإعداد الوحيد الذي يضمن ألا يحذف Redis مفاتيح الطوابير. مع `allkeys-lru` قد يحذف Redis مهمة "التسليم التلقائي لنهاية الامتحان" المؤجلة عندما يمتلئ الكاش، فيتوقف التسليم التلقائي بصمت. وسياسة الإخلاء في Redis تُضبط على مستوى النسخة كلها لا على مستوى المفتاح.

**القرار.** نسختان من Redis، والتكلفة الإضافية في الذاكرة بضعة ميغابايتات فقط:

| النسخة | الأدوار | السياسة | الاستمرارية | الحد |
|---|---|---|---|---|
| `redis-core` | طوابير BullMQ، وPub/Sub لـ WebSocket، وتحديد معدل الطلبات | `noeviction` | AOF `everysec` | 128MB |
| `redis-cache` | الكاش فقط (Cache-Aside) | `allkeys-lru` | معطلة (الكاش قابل لإعادة البناء) | 96MB |

بهذا يبقى قرار "ثلاثة أدوار في Redis" كما هو، ويتغير توزيعها فقط على نسختين.

### ADR‑N2: MinIO Community في وضع الصيانة **[جديد‑ADR، يحتاج تصديق المالك]**

**السبب الجديد.** في أواخر 2025 دخل مشروع MinIO مفتوح المصدر في وضع الصيانة ولم يعد يقبل تطويراً جديداً. قبل ذلك حُذفت واجهة الإدارة من نسخة المجتمع (فبراير 2025)، وتوقف نشر صور Docker الرسمية (أكتوبر 2025)، وانتقل الجهد إلى منتج تجاري (AIStor). النتيجة العملية أن تشغيل MinIO على خادم مكشوف للإنترنت يعني الاعتماد على نسخة قديمة بلا تحديثات أمنية مضمونة.

**القرار المقترح.** يبقى المبدأ المحسوم كما هو: تخزين كائنات ذاتي الاستضافة متوافق مع S3 داخل السودان. يتغير المحرك المقترح إلى **Garage**، وهو مشروع مكتوب بـ Rust، خفيف الاستهلاك للذاكرة (عشرات الميغابايتات مقابل نحو 300MB لـ MinIO)، ويعمل على عقدة واحدة بـ `replication_factor = 1`، ويدعم ما يحتاجه النظام فعلاً: PutObject وGetObject والرفع متعدد الأجزاء والروابط الموقّعة مسبقاً (Presigned URLs). الكود يتعامل مع واجهة S3 فقط عبر `@aws-sdk/client-s3`، فالتبديل بين Garage وSeaweedFS وMinIO تغيير في الإعدادات لا في الكود. البديل الاحتياطي هو SeaweedFS. وإن فضّل المالك البقاء على MinIO، فيجب تثبيت آخر إصدار معروف مع إخفائه خلف nginx وعدم كشف منفذه مباشرة، وتسجيل ذلك كدين تقني. **مطلوب:** تسجيل القرار في BRD مع تصحيح R2 إلى تخزين ذاتي الاستضافة.

### ADR‑N3: Schema لكل وحدة وRow Level Security للمستأجر **[جديد‑ADR]**

وثيقة الكاش تقترح Schema مستقلاً لكل وحدة في Postgres، وهذا مكمّل طبيعي لـ `dependency-cruiser`. لكل وحدة schema باسم رمزها (`krn`, `auth`, `adm`, `fac`...). المفاتيح الأجنبية عبر الـ schemas مسموحة للحفاظ على سلامة البيانات، أما الاستعلامات عبرها فممنوعة في الكود. العزل بين الجامعات يُفرض في قاعدة البيانات بـ RLS، فلو نسي المطور شرط `WHERE tenant_id` في استعلام ما، تعيد قاعدة البيانات صفر صفوف بدل أن تسرّب بيانات جامعة أخرى.

### ADR‑N4: Drizzle ORM **[جديد‑ADR، قرار لم يحسمه الملخص]**

الملخص لم يحدد طبقة الوصول للبيانات. اخترت Drizzle لأربعة أسباب. أولاً، يدعم `pgSchema` أصلاً، فيتطابق مع ADR‑N3. ثانياً، استعلاماته قريبة من SQL، فيسهل استخدام `FOR UPDATE` و`SKIP LOCKED` و`ON CONFLICT` و`tstzrange`، وهي أساسية في هذا التصميم. ثالثاً، يعمل جيداً مع PgBouncer في وضع transaction. رابعاً، أنواع TypeScript فيه مستنتجة من المخطط مباشرة. استبعدت Prisma لأن التعامل مع `SET LOCAL` لكل معاملة وأنواع Postgres المتقدمة (range وexclusion constraints) فيه أصعب، واستبعدت TypeORM لضعف أمان الأنواع في استعلاماته.

### ADR‑N5: LISTEN/NOTIFY عبر اتصال مباشر **[جديد‑ADR، قيد تقني]**

PgBouncer في وضع `transaction` لا يدعم `LISTEN`، لأن الاتصال الفعلي يتغير بين المعاملات. لذلك يفتح الـ worker **اتصالاً واحداً مباشراً** بـ Postgres مخصصاً لـ `LISTEN outbox_new`، وتمر باقي الاتصالات عبر PgBouncer. ونفس الشيء يسري على الـ migrations والنسخ الاحتياطي.

---

## 4. البنية العامة

### 4.1 مخطط السياق (C4 Level 1)

```
  [تطبيق Flutter: طالب/محاضر]   [تطبيق ويب: إداري]   [صفحة المراقب المؤقتة]   [لوحة المالك]
                │                         │                      │                    │
                └─────────────── HTTPS / WSS ─────────────────────┴────────────────────┘
                                          │
                              ┌───────────▼───────────┐
                              │     Academic Hub      │  (VPS داخل السودان)
                              └───────────┬───────────┘
               ┌──────────────────────────┼───────────────────────────┐
               ▼                          ▼                           ▼
     Google OAuth (تحقق ID Token)   FCM (إشعار بلا محتوى)   مزود AI للتصحيح (v1.1، معلّق: القسم 23)
```

### 4.2 مخطط الحاويات (C4 Level 2)

```
                         ┌─────────────────────────────────────────────┐
 Internet ──443──▶       │ nginx  (TLS, rate-limit, /api, /ws, /files) │
                         └──────┬───────────────┬──────────────┬───────┘
                                │               │              │ (presigned)
                     ┌──────────▼──────┐        │       ┌──────▼───────┐
                     │ api (NestJS)    │◀──ws───┘       │ garage (S3)  │
                     │ REST + 3 WS NS  │                └──────▲───────┘
                     └──┬────┬────┬────┘                       │
                        │    │    └──────pub/sub────┐          │
               ┌────────▼┐   │               ┌──────▼──────┐   │
               │pgbouncer│   │  cache        │ redis-core  │   │
               └────┬────┘   └──────────────▶│ queues/pubsub│  │
                    │        ┌──────────────┐└──────▲──────┘   │
                    │        │ redis-cache  │       │          │
                    │        └──────────────┘       │          │
               ┌────▼─────┐  direct LISTEN   ┌──────┴────────┐ │
               │ postgres │◀─────────────────│ worker(NestJS)│─┘
               └──────────┘                  └───────────────┘
```

### 4.3 تدفق طلب نموذجي (كتابة تغيّر حالة)

```
Client ─▶ nginx ─▶ api: AuthGuard → TenantGuard → RoleGuard/PermissionGuard → IdempotencyInterceptor
   └─▶ Controller ─▶ Module Service ─▶ TenantTx.begin (SET LOCAL app.tenant_id)
          ├─ StateMachine.transition()  ── UPDATE + audit_log + events_outbox (نفس المعاملة)
          └─ COMMIT ─▶ NOTIFY outbox_new
worker: LISTEN ─▶ relay ─▶ BullMQ (job لكل handler) ─▶ handlers: NOT / CacheInvalidator / وحدات مستمعة
```

---

## 5. هيكل الكود وحدود الوحدات

### 5.1 هيكل المستودع

```
academic-hub/
├── src/
│   ├── main.api.ts            # وضع api
│   ├── main.worker.ts         # وضع worker (نفس الصورة: CMD مختلف)
│   ├── kernel/                # KRN: db, tenant-context, fsm, outbox, idempotency, cache, audit, files-core
│   ├── modules/
│   │   ├── auth/  own/  adm/  fac/  att/  exm/  cht/  prc/
│   │   ├── grd/   pay/  cha/  fil/  not/  dsh/  set/
│   │   └── <module>/
│   │       ├── <module>.module.ts
│   │       ├── public/            # الشيء الوحيد المسموح استيراده من خارج الوحدة
│   │       │   ├── <module>.facade.ts
│   │       │   ├── events.ts      # تعريف الأحداث التي تُصدرها الوحدة
│   │       │   └── dto.ts
│   │       ├── domain/            # منطق نقي + تعريف آلة الحالات (بلا NestJS)
│   │       ├── infra/             # repositories, schema.ts (drizzle), cache keys
│   │       ├── http/              # controllers
│   │       ├── ws/                # gateways (إن وجدت)
│   │       └── handlers/          # مستمعو الأحداث (يعملون في worker)
│   └── shared/                 # أنواع وأدوات بلا حالة (Result, Money, Clock)
├── migrations/                 # SQL مولّد + يدوي (RLS, triggers, exclusion)
├── test/                       # integration (testcontainers)
└── .dependency-cruiser.cjs
```

### 5.2 فرض الحدود آلياً

```js
// .dependency-cruiser.cjs (مقتطف)
module.exports = {
  forbidden: [
    {
      name: 'no-cross-module-internals',
      comment: 'وحدة لا تستورد من وحدة أخرى إلا عبر public/',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/' },
      to:   { path: '^src/modules/([^/]+)/(?!public/)', pathNot: '^src/modules/$1/' },
    },
    {
      name: 'no-direct-redis',
      comment: 'لا أحد يستورد ioredis إلا kernel/cache و kernel/queue',
      severity: 'error',
      from: { pathNot: '^src/kernel/(cache|queue|realtime)/' },
      to:   { path: 'node_modules/ioredis' },
    },
    {
      name: 'domain-is-pure',
      severity: 'error',
      from: { path: '/domain/' },
      to:   { path: '(@nestjs|drizzle-orm|ioredis|/infra/)' },
    },
  ],
};
```

وتُضاف قاعدة ESLint مخصصة تمنع كتابة `.set({ state: ... })` أو `status:` على الجداول التي تحكمها آلات الحالات، خارج `kernel/fsm`. الـ trigger في القسم 9.3 هو خط الدفاع الأخير.

### 5.3 عقد الـ Facade

```ts
// src/modules/adm/public/adm.facade.ts
export abstract class AdmFacade {
  abstract getStudentBrief(studentId: string): Promise<StudentBrief | null>;
  abstract listCohortStudentIds(cohortId: string, opts?: { activeOnly?: boolean }): Promise<string[]>;
  abstract getSemesterContext(semesterId: string): Promise<SemesterContext>;
  abstract isStudentDocumentsVerified(studentId: string): Promise<boolean>; // FR-AUTH-015
}
// تُصدَّر من AdmModule كـ provider؛ الوحدات الأخرى تحقن AdmFacade فقط.
```

القاعدة: الـ Facade للقراءة المتزامنة التي يحتاجها المستدعي فوراً، مثل فحص أهلية الطالب قبل دخول الامتحان. أي أثر جانبي في وحدة أخرى يتم عبر حدث.

---

## 6. تعدد المستأجرين

### 6.1 سياق المستأجر

يُستخرج `tenantId` من رمز الدخول (JWT claim `tid`) في `TenantGuard`، ويوضع في `AsyncLocalStorage` عبر `nestjs-cls`. لا يقرأ أي كود الـ tenant من body أو query.

```ts
// src/kernel/db/tenant-tx.ts
@Injectable()
export class TenantTx {
  constructor(private readonly db: Db, private readonly cls: ClsService) {}

  async run<T>(fn: (tx: Tx) => Promise<T>, opts?: { tenantId?: string }): Promise<T> {
    const tenantId = opts?.tenantId ?? this.cls.get<string>('tenantId');
    if (!tenantId) throw new Error('TENANT_CONTEXT_MISSING');
    return this.db.transaction(async (tx) => {
      // SET LOCAL يعمل بأمان مع PgBouncer transaction mode لأنه ينتهي بانتهاء المعاملة
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      return fn(tx);
    });
  }
}
```

كل استعلام على جدول يخص جامعة يجب أن يعمل داخل `TenantTx.run`. ويطلق الـ repository خطأً إذا استُدعي خارج معاملة.

### 6.2 RLS: النمط الموحد لكل جدول

```sql
ALTER TABLE adm.students ENABLE ROW LEVEL SECURITY;
ALTER TABLE adm.students FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON adm.students
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

أدوار قاعدة البيانات أربعة: `ah_migrator` يملك الجداول ويُستخدم للـ migrations فقط. `ah_app` يُستخدم لـ api وworker، وليس مالكاً للجداول ولا يملك `BYPASSRLS`. `ah_owner_portal` يصل إلى schema `own` فقط. `ah_backup` للقراءة لأغراض النسخ الاحتياطي. وإن لم يُضبط `app.tenant_id`، يعيد `current_setting(..., true)` القيمة NULL فلا يُرجع أي صف. أي أن الفشل يكون في الاتجاه الآمن.

### 6.3 مفاتيح أجنبية مركبة

كل جدول يخص جامعة يحمل `UNIQUE (tenant_id, id)`، وكل مفتاح أجنبي يكون مركباً:

```sql
FOREIGN KEY (tenant_id, cohort_id) REFERENCES adm.cohorts (tenant_id, id)
```

بهذا يستحيل في قاعدة البيانات أن يشير طالب في جامعة A إلى دفعة في جامعة B، حتى لو كان المعرف صحيحاً.

### 6.4 المستخدم في أكثر من جامعة

البريد فريد داخل الجامعة الواحدة (`UNIQUE (tenant_id, email)`)، لا على مستوى المنصة. فإذا وُجد البريد نفسه في جامعتين، كمحاضر يدرّس في جامعتين مثلاً، تعرض شاشة الدخول اختيار الجامعة بعد التحقق من Google، ويصدر رمز لكل جامعة منفصلاً. هذا يحتاج تأكيداً في BRD **[افتراض‑SD]**.

---

## 7. المصادقة والتفويض والأجهزة

### 7.1 تدفق الدخول

```
Flutter: Google Sign-In ──▶ id_token
POST /api/v1/auth/google { idToken, deviceProof, tenantHint? }
  1. التحقق من التوقيع والـ audience والانتهاء (google-auth-library)
  2. email = payload.email (email_verified = true إلزامي)
  3. البحث عن users بالبريد (عبر دالة SECURITY DEFINER تتجاوز RLS لهذه الخطوة فقط)
       لا يوجد  → 403 + رسالة توجيه (FR-AUTH-010) + حدث UnknownEmailLoginAttempt (FR-AUTH-026)
       أكثر من جامعة → 300 قائمة الجامعات
  4. فحص الجهاز (7.3)
  5. PENDING_FIRST_LOGIN → ACTIVE + ربط google_sub
  6. إصدار access JWT (15 دقيقة) + refresh token (30 يوماً، rotation، مرتبط بـ device_id)
```

محتوى الـ JWT: `sub` و`tid` و`role` و`did` (الجهاز) و`perm_v` (نسخة الصلاحيات، تُبطل الرموز القديمة عند تغيير صلاحيات إداري فرعي). وتُخزن الصلاحيات المفصلة في الكاش لا في الرمز.

### 7.2 دوران الـ Refresh Token

يُخزن الـ refresh token كـ hash، ويتبع لعائلة (`family_id`). إذا استُخدم رمز سبق استهلاكه، تُعتبر العائلة مسروقة وتُبطل كلها، ويُرسل إشعار أمني للمستخدم.

### 7.3 ربط الجهاز (FR-AUTH-017 إلى 019)

| المرحلة | أندرويد (طالب/محاضر) | ويب (إداري) |
|---|---|---|
| MVP | `installation_id` عشوائي يولّده التطبيق ويحفظه في Android Keystore المشفّر، ومعه بصمة الجهاز (طراز وإصدار نظام) | كوكي `HttpOnly; Secure; SameSite=Strict` يحمل `device_id` عشوائياً طويل العمر |
| v1.1 | زوج مفاتيح في Android Keystore، وكل تجديد للرمز يوقّع challenge من الخادم | WebAuthn اختياري |

جهاز غير معروف يُنشئ `device_change_requests` بحالة PENDING ويعيد `403 DEVICE_PENDING_APPROVAL`. موافقة تغيير جهاز الطالب أو المحاضر تكون للإداري، وجهاز الإداري الرئيسي للمالك. وتطلق محاولة الدخول من جهاز غير معروف إشعاراً فورياً بزر "لست أنا" (FR-AUTH-025)، وهذا الزر يبطل كل العائلات النشطة.

### 7.4 الصلاحيات

| الطبقة | الأداة | المثال |
|---|---|---|
| الدور | `@Roles('ADMIN_MAIN','ADMIN_SUB')` و`RoleGuard` | لا يصل المحاضر إلى `/adm/students` (FR-ADM-013) |
| صلاحية اللوحة (للإداري الفرعي) | `@Permission('pay.review', 'WRITE')` و`PermissionGuard` | مصفوفة FR-AUTH-006: قراءة، أو قراءة وتعديل، أو تحكم كامل |
| الملكية | فحص داخل الخدمة | المحاضر لا يعدّل إلا موازين التكليفات المسندة إليه |
| آلة الحالات | `roles` في تعريف الانتقال | تثبيت الغش للإداري الرئيسي فقط |

الإداري الرئيسي يملك كل الصلاحيات ضمنياً، ولا تُخزن له مصفوفة.

### 7.5 وصول المراقب (FR-AUTH-020)

ينشئ الإداري عند جدولة الامتحان عدداً من حسابات الوصول. لكل منها رابط مستقل وكلمة دخول عشوائية من 10 محارف تُعرض مرة واحدة ويُخزن الـ hash فقط (argon2id). يصدر للمراقب JWT بدور `PROCTOR` ويحمل `exam_id`، وصلاحيته من `starts_at - 30min` إلى `ends_at + 30min`. يحدث المراقب WebSocket `/ws/proctor` فقط، ولا يصل إلى أي REST خارج نطاق جلسته. وبعد انتهاء الجلسة يُغلق الاتصال من الخادم، ويُدرج الـ `jti` في قائمة إبطال داخل `redis-core`.

---

## 8. مخطط قاعدة البيانات

### 8.1 اصطلاحات عامة

النسخة PostgreSQL 18، والمعرفات `uuid` تُولّد بـ `uuidv7()` المدمجة فيها. هذه المعرفات مرتبة زمنياً، فتحافظ على كفاءة فهارس B-tree. وإن استُخدم Postgres 17 تولّدها التطبيقات بنفس الصيغة. جداول السجلات عالية الحجم (audit وoutbox وmessages) تستخدم `bigint generated always as identity`. الأوقات كلها `timestamptz` بتوقيت UTC، والعرض بتوقيت `Africa/Khartoum` في الواجهة. المبالغ `numeric(14,2)` بعملة SDG، ولا يُستخدم `float` في أي مبلغ أو درجة. البريد من نوع `citext`. الحالات من نوع `text` مع `CHECK` بدل `ENUM` في Postgres، لأن تعديل CHECK في migration أسهل. كل جدول يخص جامعة يحمل `tenant_id` و`created_at` و`UNIQUE(tenant_id,id)` وRLS بالنمط في 6.2. أدناه أكتب DDL مختصراً لكل وحدة. الأعمدة البديهية (`created_at` و`updated_at` وقيد RLS) محذوفة من بعض الجداول للاختصار، لكنها إلزامية في الـ migration الفعلي.

### 8.2 النواة المشتركة (`krn`)

```sql
CREATE SCHEMA krn;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- لقيود منع التداخل الزمني في FAC
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

CREATE TABLE krn.institutions (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  code        text NOT NULL UNIQUE,          -- يُستخدم في مفاتيح الكاش: ah:{code}:...
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','DISABLED')), -- FR-OWN-005
  timezone    text NOT NULL DEFAULT 'Africa/Khartoum',
  created_at  timestamptz NOT NULL DEFAULT now()
);  -- لا RLS: يقرأها النظام لحل سياق المستأجر

CREATE TABLE krn.users (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL REFERENCES krn.institutions(id),
  email         citext NOT NULL,
  google_sub    text,
  role          text NOT NULL CHECK (role IN ('ADMIN_MAIN','ADMIN_SUB','LECTURER','STUDENT')),
  status        text NOT NULL DEFAULT 'PENDING_FIRST_LOGIN'
                CHECK (status IN ('PENDING_FIRST_LOGIN','ACTIVE','DISABLED')),   -- FR-AUTH-008/022
  display_name  text NOT NULL,
  job_title     text,
  perm_version  int  NOT NULL DEFAULT 1,
  last_login_at timestamptz,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, email)
);
CREATE UNIQUE INDEX one_main_admin_per_tenant ON krn.users (tenant_id) WHERE role = 'ADMIN_MAIN' AND status <> 'DISABLED';

-- سجل التدقيق: append-only + سلسلة hash لكشف العبث (FR-AUTH-023)
CREATE TABLE krn.audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id     uuid NOT NULL,
  actor_id      uuid,
  actor_role    text,
  action        text NOT NULL,            -- 'fsm.transition', 'student.document.viewed', 'permission.changed'
  entity_type   text NOT NULL,
  entity_id     text NOT NULL,
  before        jsonb,
  after         jsonb,
  ip            inet,
  device_id     uuid,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  prev_hash     bytea,
  hash          bytea NOT NULL,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);         -- تقسيم شهري يُنشئه worker مسبقاً
CREATE INDEX ON krn.audit_log (tenant_id, entity_type, entity_id, occurred_at DESC);

CREATE FUNCTION krn.forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON krn.audit_log
  FOR EACH ROW EXECUTE FUNCTION krn.forbid_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON krn.audit_log FROM ah_app;

CREATE TABLE krn.events_outbox (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id       uuid NOT NULL DEFAULT uuidv7() UNIQUE,
  tenant_id      uuid NOT NULL,
  event_type     text NOT NULL,          -- 'exm.ExamSubmitted.v1'
  aggregate_type text NOT NULL,
  aggregate_id   text NOT NULL,
  payload        jsonb NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  attempts       int NOT NULL DEFAULT 0,
  last_error     text
);
CREATE INDEX outbox_unpublished ON krn.events_outbox (id) WHERE published_at IS NULL;

CREATE TABLE krn.processed_events (       -- Idempotency للمستمعين
  handler    text NOT NULL,
  event_id   uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (handler, event_id)
);

CREATE TABLE krn.idempotency_keys (        -- القسم 11
  tenant_id     uuid NOT NULL,
  key           uuid NOT NULL,
  user_id       uuid NOT NULL,
  route         text NOT NULL,
  request_hash  bytea NOT NULL,
  status        text NOT NULL CHECK (status IN ('IN_PROGRESS','COMPLETED')),
  response_code int,
  response_body jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '48 hours',
  PRIMARY KEY (tenant_id, key)
);
CREATE INDEX ON krn.idempotency_keys (expires_at);

CREATE TABLE krn.files (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES krn.institutions(id),
  bucket      text NOT NULL,
  object_key  text NOT NULL,             -- {tenant}/{module}/{yyyy}/{mm}/{uuid}
  mime        text NOT NULL,
  size_bytes  bigint NOT NULL CHECK (size_bytes > 0),
  sha256      bytea,
  sensitivity text NOT NULL DEFAULT 'NORMAL' CHECK (sensitivity IN ('NORMAL','PII','FINANCIAL')),
  status      text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','READY','QUARANTINED','DELETED')),
  uploaded_by uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (bucket, object_key)
);

-- جدول الانتقالات المسموحة: مرجع للـ trigger في 9.3
CREATE TABLE krn.fsm_transitions (
  machine text NOT NULL, from_state text NOT NULL, to_state text NOT NULL,
  PRIMARY KEY (machine, from_state, to_state)
);
```

### 8.3 الهوية والوصول (`auth`)

```sql
CREATE TABLE auth.devices (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL,
  user_id         uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('ANDROID','WEB')),
  installation_id text NOT NULL,
  public_key      bytea,                          -- v1.1
  label           text,                           -- "Samsung A14 / Android 14"
  status          text NOT NULL CHECK (status IN ('PENDING_APPROVAL','ACTIVE','REVOKED')),
  approved_by     uuid,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz,
  last_ip         inet,
  approx_location text,                           -- FR-AUTH-021
  FOREIGN KEY (tenant_id, user_id) REFERENCES krn.users(tenant_id, id),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, user_id, installation_id)
);
-- جهاز نشط واحد لكل مستخدم (FR-AUTH-017)
CREATE UNIQUE INDEX one_active_device ON auth.devices (tenant_id, user_id) WHERE status = 'ACTIVE';

CREATE TABLE auth.device_change_requests (
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL, user_id uuid NOT NULL,
  new_device_id uuid NOT NULL, approver_scope text NOT NULL CHECK (approver_scope IN ('TENANT_ADMIN','OWNER')),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  decided_by uuid, decided_at timestamptz, reason text,
  FOREIGN KEY (tenant_id, new_device_id) REFERENCES auth.devices(tenant_id, id)
);

CREATE TABLE auth.sessions (
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL, user_id uuid NOT NULL,
  device_id uuid NOT NULL, family_id uuid NOT NULL, refresh_hash bytea NOT NULL UNIQUE,
  replaced_by uuid, expires_at timestamptz NOT NULL, revoked_at timestamptz,
  last_activity_at timestamptz NOT NULL DEFAULT now()    -- انتهاء الخمول FR-AUTH-024
);
CREATE INDEX ON auth.sessions (tenant_id, user_id) WHERE revoked_at IS NULL;

CREATE TABLE auth.permission_templates (           -- FR-AUTH-007
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL,
  name text NOT NULL, matrix jsonb NOT NULL, is_builtin boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, name)
);
CREATE TABLE auth.admin_permissions (               -- FR-AUTH-006
  tenant_id uuid NOT NULL, user_id uuid NOT NULL, panel_code text NOT NULL,
  level text NOT NULL CHECK (level IN ('READ','WRITE','FULL')),
  PRIMARY KEY (tenant_id, user_id, panel_code),
  FOREIGN KEY (tenant_id, user_id) REFERENCES krn.users(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE auth.consents (                        -- FR-AUTH-016
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL, user_id uuid NOT NULL,
  consent_type text NOT NULL, policy_version text NOT NULL, device_id uuid,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, consent_type, policy_version)
);

CREATE TABLE auth.proctor_accesses (                -- FR-AUTH-020
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL, exam_session_id uuid NOT NULL,
  label text NOT NULL, password_hash text NOT NULL,
  valid_from timestamptz NOT NULL, valid_until timestamptz NOT NULL, revoked_at timestamptz,
  CHECK (valid_until > valid_from)
);

CREATE TABLE auth.unknown_login_attempts (          -- FR-AUTH-026 (بلا tenant_id أحياناً)
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, email citext NOT NULL,
  tenant_hint uuid, ip inet, attempted_at timestamptz NOT NULL DEFAULT now()
);
```

### 8.4 المستأجرون والفوترة (`own`، بلا RLS ويصلها دور المالك فقط)

```sql
CREATE TABLE own.platform_owners (id uuid PRIMARY KEY DEFAULT uuidv7(), email citext UNIQUE NOT NULL, device_id uuid);
CREATE TABLE own.subscriptions (
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL REFERENCES krn.institutions(id),
  period_start date NOT NULL, period_end date NOT NULL,
  price_per_student numeric(14,2) NOT NULL, status text NOT NULL CHECK (status IN ('ACTIVE','GRACE','EXPIRED')),
  EXCLUDE USING gist (tenant_id WITH =, daterange(period_start, period_end) WITH &&)
);
CREATE TABLE own.billing_counters (                 -- FR-OWN-004: لقطة يومية من حدث، لا قراءة من adm
  tenant_id uuid NOT NULL, snapshot_date date NOT NULL, active_students int NOT NULL,
  PRIMARY KEY (tenant_id, snapshot_date)
);
CREATE TABLE own.tenant_active_students (           -- عدّاد حي يُحدَّث بأحداث StudentActivated/Deactivated
  tenant_id uuid NOT NULL, student_id uuid NOT NULL, PRIMARY KEY (tenant_id, student_id)
);  -- يحمل معرّفات فقط بلا أي PII (FR-OWN-003)
CREATE TABLE own.owner_audit_log (LIKE krn.audit_log INCLUDING DEFAULTS);   -- FR-OWN-006 سجل مستقل
```

### 8.5 الإدارة الأكاديمية (`adm`)

```sql
CREATE TABLE adm.programs (
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL,
  name text NOT NULL, category text NOT NULL CHECK (category IN ('DIPLOMA','BACHELOR','MASTER','PHD')),
  semesters_count smallint NOT NULL CHECK (semesters_count BETWEEN 1 AND 16),
  description text, UNIQUE (tenant_id, id), UNIQUE (tenant_id, name)
);

CREATE TABLE adm.courses (                          -- FR-ADM-003
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL, program_id uuid NOT NULL,
  semester_no smallint NOT NULL, name text NOT NULL,
  theory_hours numeric(4,1) NOT NULL DEFAULT 0, practical_hours numeric(4,1) NOT NULL DEFAULT 0,
  credit_hours numeric(4,1) NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, program_id) REFERENCES adm.programs(tenant_id, id) ON DELETE RESTRICT  -- FR-ADM-005
);

CREATE TABLE adm.cohorts (                          -- FR-ADM-008
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL, program_id uuid NOT NULL,
  entry_year smallint NOT NULL, name text NOT NULL,
  current_semester_no smallint NOT NULL DEFAULT 1,
  tuition_fee numeric(14,2) NOT NULL CHECK (tuition_fee >= 0),
  registration_fee numeric(14,2) NOT NULL CHECK (registration_fee >= 0),
  min_admission_pct numeric(5,2) CHECK (min_admission_pct BETWEEN 0 AND 100),   -- القرار (22)
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, program_id, entry_year),
  FOREIGN KEY (tenant_id, program_id) REFERENCES adm.programs(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE adm.students (                         -- FR-ADM-014/015/019
  id uuid PRIMARY KEY,                               -- = krn.users.id
  tenant_id uuid NOT NULL, cohort_id uuid NOT NULL,
  university_no text NOT NULL, full_name text NOT NULL,
  birth_date date, birthplace text, prior_pct numeric(5,2),
  phone1 text, phone2 text, guardian_phone1 text, guardian_phone2 text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','WITHDRAWN','GRADUATED')),
  profile_completed_at timestamptz,                  -- FR-AUTH-013
  documents_verified_at timestamptz,                 -- FR-AUTH-015
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, university_no),
  FOREIGN KEY (tenant_id, id) REFERENCES krn.users(tenant_id, id),
  FOREIGN KEY (tenant_id, cohort_id) REFERENCES adm.cohorts(tenant_id, id) ON DELETE RESTRICT  -- FR-ADM-010
);
CREATE INDEX students_search ON adm.students USING gin (full_name gin_trgm_ops);   -- FR-ADM-011 (pg_trgm)
CREATE INDEX ON adm.students (tenant_id, cohort_id, full_name);                    -- FR-ADM-012

CREATE TABLE adm.student_documents (               -- FR-AUTH-014، FR-ADM-037/038
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL, student_id uuid NOT NULL,
  doc_type text NOT NULL CHECK (doc_type IN ('NATIONAL_ID','PRIOR_CERTIFICATE','MEDICAL')),
  file_id uuid NOT NULL, status text NOT NULL DEFAULT 'PENDING_REVIEW'
    CHECK (status IN ('PENDING_REVIEW','VERIFIED','REJECTED')),
  reject_reason text, reviewed_by uuid, reviewed_at timestamptz,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'REJECTED' OR reject_reason IS NOT NULL),     -- الرفض مشروط بسبب
  FOREIGN KEY (tenant_id, file_id) REFERENCES krn.files(tenant_id, id)
);
CREATE INDEX ON adm.student_documents (tenant_id, submitted_at) WHERE status = 'PENDING_REVIEW';

CREATE TABLE adm.lecturers (                        -- FR-ADM-036
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, full_name text NOT NULL, bio text,
  phone1 text, phone2 text, photo_file_id uuid,
  UNIQUE (tenant_id, id), FOREIGN KEY (tenant_id, id) REFERENCES krn.users(tenant_id, id)
);

CREATE TABLE adm.semesters (                        -- نسخة تشغيلية لفصل رقمي لدفعة (5.1 في BRD)
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL, cohort_id uuid NOT NULL,
  semester_no smallint NOT NULL,
  state text NOT NULL DEFAULT 'IDLE' CHECK (state IN ('IDLE','PREPARATION','IN_PROGRESS','RESULTS','ARCHIVED')),
  version int NOT NULL DEFAULT 1,
  idle_announcement text,                            -- FR-ADM-021
  state_changed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, cohort_id, semester_no),
  FOREIGN KEY (tenant_id, cohort_id) REFERENCES adm.cohorts(tenant_id, id)
);
-- فصل غير مؤرشف واحد فقط لكل دفعة في أي لحظة
CREATE UNIQUE INDEX one_open_semester ON adm.semesters (tenant_id, cohort_id) WHERE state <> 'ARCHIVED';

CREATE TABLE adm.lecturer_assignments (            -- "تكليف المحاضر" (5.1، 5.2 في BRD)
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL,
  semester_id uuid NOT NULL, course_id uuid NOT NULL, lecturer_id uuid NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(), unassigned_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, semester_id) REFERENCES adm.semesters(tenant_id, id),
  FOREIGN KEY (tenant_id, course_id)   REFERENCES adm.courses(tenant_id, id),
  FOREIGN KEY (tenant_id, lecturer_id) REFERENCES adm.lecturers(tenant_id, id)
);
CREATE UNIQUE INDEX one_active_assignment ON adm.lecturer_assignments (tenant_id, semester_id, course_id, lecturer_id)
  WHERE unassigned_at IS NULL;

CREATE TABLE adm.archives (                         -- FR-ADM-040..043
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL, semester_id uuid NOT NULL UNIQUE,
  file_id uuid, wrapped_key bytea,                   -- كلمة سر الأرشيف مشفّرة بمفتاح رئيسي (Envelope)
  status text NOT NULL DEFAULT 'BUILDING' CHECK (status IN ('BUILDING','READY','FAILED')),
  manifest jsonb, external_download_at timestamptz,  -- OBJ-06 / SY-32/33
  built_at timestamptz
);
```

### 8.6 المنشآت والجداول (`fac`)

هنا تظهر ميزة Postgres على غيره: قيود `EXCLUDE` تمنع التعارض الزمني في قاعدة البيانات نفسها، فلا تقع حالة السباق التي يقع فيها فحص يدوي من نوع "اقرأ ثم اكتب".

```sql
CREATE TABLE fac.facilities (
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL,
  name text NOT NULL, kind text NOT NULL CHECK (kind IN ('HALL','LAB','OTHER')),
  capacity int NOT NULL CHECK (capacity > 0), size_note text, active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, name)
);

CREATE TABLE fac.schedule_events (                 -- "الحدث" في 5.1: محاضرة/سمنار/معمل/امتحان/واجب/بحث
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL,
  assignment_id uuid NOT NULL, cohort_id uuid NOT NULL, lecturer_id uuid,
  kind text NOT NULL CHECK (kind IN ('LECTURE','SEMINAR','LAB','EXAM','ASSIGNMENT','RESEARCH')),
  title text, during tstzrange, due_at timestamptz,
  source_ref uuid,                                   -- exam_session_id عند kind='EXAM'
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','CONFIRMED','CANCELLED')),
  recurrence_group uuid,                             -- محاضرات أسبوعية متكررة تُولَّد كصفوف
  UNIQUE (tenant_id, id),
  CHECK ((kind IN ('LECTURE','SEMINAR','LAB','EXAM') AND during IS NOT NULL AND due_at IS NULL)
      OR (kind IN ('ASSIGNMENT','RESEARCH') AND due_at IS NOT NULL AND during IS NULL)),
  -- لا تتداخل محاضرتان لنفس الدفعة، ولا لنفس المحاضر
  EXCLUDE USING gist (tenant_id WITH =, cohort_id WITH =, during WITH &&)
    WHERE (status <> 'CANCELLED' AND during IS NOT NULL),
  EXCLUDE USING gist (tenant_id WITH =, lecturer_id WITH =, during WITH &&)
    WHERE (status <> 'CANCELLED' AND during IS NOT NULL AND lecturer_id IS NOT NULL)
);

CREATE TABLE fac.bookings (
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL,
  facility_id uuid NOT NULL, event_id uuid NOT NULL, during tstzrange NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CANCELLED')),
  FOREIGN KEY (tenant_id, facility_id) REFERENCES fac.facilities(tenant_id, id),
  FOREIGN KEY (tenant_id, event_id) REFERENCES fac.schedule_events(tenant_id, id),
  EXCLUDE USING gist (tenant_id WITH =, facility_id WITH =, during WITH &&) WHERE (status = 'ACTIVE')
);  -- امتحان واحد قد يحجز عدة قاعات: عدة صفوف لنفس event_id

CREATE TABLE fac.booking_requests (
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL, assignment_id uuid NOT NULL,
  requested_by uuid NOT NULL, desired jsonb NOT NULL, suggestions jsonb,   -- الاقتراح الآلي v1.1
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','WITHDRAWN')),
  decided_by uuid, decided_at timestamptz
);

CREATE TABLE fac.schedule_conflicts (              -- سجل لما رُفض أو اكتُشف (SY-06/07، OBJ-08)
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('FACILITY','COHORT','LECTURER')),
  attempted jsonb NOT NULL, conflicting_ids uuid[] NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
);
```

عندما يرفض Postgres الإدخال بالخطأ `23P01` (exclusion_violation)، يلتقطه الـ repository ويحوّله إلى `409 SCHEDULE_CONFLICT`، ويعيد الحدث المتعارض، ويسجّل صفاً في `schedule_conflicts`.

### 8.7 الحضور (`att`)

```sql
CREATE TABLE att.attendance_sessions (
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL,
  schedule_event_id uuid NOT NULL, method text NOT NULL CHECK (method IN ('BLUETOOTH','QR','EXAM_BARCODE')),
  state text NOT NULL DEFAULT 'SCHEDULED'
    CHECK (state IN ('SCHEDULED','OPEN','CLOSED','UNDER_ARBITRATION','FINALIZED','CANCELLED')),
  version int NOT NULL DEFAULT 1,
  assistant1_id uuid, assistant2_id uuid,            -- آلية البلوتوث بمساعدَين
  qr_secret bytea,                                   -- QR متجدد: HMAC(secret, floor(now/15s))
  opened_by uuid, opened_at timestamptz, closed_at timestamptz, finalized_at timestamptz,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, schedule_event_id, method),
  CHECK (assistant1_id IS NULL OR assistant1_id <> assistant2_id)
);

CREATE TABLE att.attendance_uploads (              -- كل رفعة خام من مساعد أو محاضر (لا تُعدّل)
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL, session_id uuid NOT NULL,
  uploader_id uuid NOT NULL, uploader_slot text NOT NULL CHECK (uploader_slot IN ('ASSISTANT_1','ASSISTANT_2','LECTURER','PROCTOR')),
  idempotency_key uuid NOT NULL, captured_at_client timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), payload jsonb NOT NULL,   -- قائمة student_id + rssi/scan_ts
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE att.attendance_records (              -- النتيجة المدمجة: صف لكل طالب لكل جلسة
  tenant_id uuid NOT NULL, session_id uuid NOT NULL, student_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('PRESENT','ABSENT','LATE','EXCUSED','DISPUTED')),
  sources text[] NOT NULL DEFAULT '{}',              -- {'ASSISTANT_1','ASSISTANT_2'}
  decided_by uuid,                                   -- عند التحكيم اليدوي (OBJ-03)
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, session_id, student_id)
);

CREATE TABLE att.violations (
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL, session_id uuid NOT NULL,
  student_id uuid NOT NULL, kind text NOT NULL,      -- [افتراض‑SD] QR_REPLAY, DEVICE_MISMATCH, ...
  details jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
```

قاعدة الدمج: الطالب الذي رصده المساعدان معاً PRESENT. الذي رصده أحدهما فقط DISPUTED ويذهب لتحكيم المحاضر. وغير المرصود ABSENT عند الإغلاق.

### 8.8 الامتحانات (`exm`)

```sql
CREATE TABLE exm.questions (                       -- بنك الأسئلة (مرتبط بالتكليف: 5.2 في BRD)
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL,
  course_id uuid NOT NULL, assignment_id uuid NOT NULL, author_id uuid NOT NULL,
  qtype text NOT NULL CHECK (qtype IN ('MCQ_SINGLE','MCQ_MULTI','TRUE_FALSE','SHORT_ANSWER','ESSAY','DIAGRAM')), -- [افتراض‑SD] الأنواع الستة
  difficulty text CHECK (difficulty IN ('EASY','MEDIUM','HARD')), topic text,
  body jsonb NOT NULL, answer_key jsonb, grading_instructions text,   -- تعليمات المحاضر للـ AI
  default_points numeric(6,2) NOT NULL CHECK (default_points > 0),
  version int NOT NULL DEFAULT 1, archived_at timestamptz,
  UNIQUE (tenant_id, id)
);
CREATE INDEX ON exm.questions (tenant_id, assignment_id, topic) WHERE archived_at IS NULL;

CREATE TABLE exm.exam_sessions (                   -- FR-ADM-027..031
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL,
  semester_id uuid NOT NULL, course_id uuid NOT NULL, assignment_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ONLINE','PAPER','PRACTICAL')),
  scope text NOT NULL CHECK (scope IN ('MIDTERM','FINAL')),
  purpose text NOT NULL CHECK (purpose IN ('GRADED','DIAGNOSTIC')),
  parent_exam_id uuid,                               -- امتحان الملحق (FR-ADM-028/029)
  schedule_event_id uuid,
  starts_at timestamptz, ends_at timestamptz,
  duration interval, pdf_file_id uuid,
  state text NOT NULL DEFAULT 'DRAFT' CHECK (state IN
    ('DRAFT','REQUESTED','SCHEDULED','READY','LIVE','ENDED','GRADING','GRADED','PUBLISHED','CANCELLED')),
  version int NOT NULL DEFAULT 1,
  questions_confirmed_at timestamptz, questions_confirmed_by uuid,
  settings jsonb NOT NULL DEFAULT '{}',              -- خلط الأسئلة، grace window، ...
  UNIQUE (tenant_id, id),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  FOREIGN KEY (tenant_id, parent_exam_id) REFERENCES exm.exam_sessions(tenant_id, id)
);

CREATE TABLE exm.exam_questions (                  -- لقطة مجمّدة: تعديل البنك لا يغيّر امتحاناً مؤكداً
  tenant_id uuid NOT NULL, exam_id uuid NOT NULL, question_id uuid NOT NULL,
  position smallint NOT NULL, points numeric(6,2) NOT NULL, snapshot jsonb NOT NULL,
  PRIMARY KEY (tenant_id, exam_id, question_id)
);

CREATE TABLE exm.exam_eligibility (                -- الحرمان ورفعه (RACI: رفع الحرمان للإداري الرئيسي)
  tenant_id uuid NOT NULL, exam_id uuid NOT NULL, student_id uuid NOT NULL,
  eligible boolean NOT NULL, reasons text[] NOT NULL DEFAULT '{}',   -- 'FINANCIAL','ATTENDANCE','DOCUMENTS'
  lifted_by uuid, lifted_at timestamptz, lift_reason text,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, exam_id, student_id)
);

CREATE TABLE exm.submissions (
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL,
  exam_id uuid NOT NULL, student_id uuid NOT NULL, device_id uuid,
  status text NOT NULL DEFAULT 'NOT_STARTED'
    CHECK (status IN ('NOT_STARTED','IN_PROGRESS','SUBMITTED','AUTO_SUBMITTED','ABSENT','VOIDED')),
  started_at timestamptz, server_deadline timestamptz,    -- مرجع الوقت = الخادم
  submitted_at timestamptz, last_client_seq bigint NOT NULL DEFAULT 0,
  total_score numeric(7,2), late_synced boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, exam_id, student_id)
);

CREATE TABLE exm.submission_answers (
  tenant_id uuid NOT NULL, submission_id uuid NOT NULL, question_id uuid NOT NULL,
  answer jsonb NOT NULL, client_seq bigint NOT NULL, client_saved_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  score numeric(6,2), score_source text CHECK (score_source IN ('AUTO','AI_SUGGESTED','MANUAL')),
  PRIMARY KEY (tenant_id, submission_id, question_id)
);
```

### 8.9 التصحيح (`cht`، v1.1)

```sql
CREATE TABLE cht.grading_jobs (
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL,
  submission_id uuid NOT NULL, question_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','FALLBACK_MANUAL')),
  attempts smallint NOT NULL DEFAULT 0, last_error text, model text,
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  UNIQUE (tenant_id, submission_id, question_id)          -- يمنع تكرار المهمة عند إعادة الحدث
);
CREATE TABLE cht.ai_grading_results (
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL, job_id uuid NOT NULL UNIQUE,
  suggested_score numeric(6,2) NOT NULL, rationale text, confidence numeric(4,3),
  final_score numeric(6,2), reviewed_by uuid, reviewed_at timestamptz   -- مراجعة بشرية إلزامية
);
```

### 8.10 مكافحة الغش (`prc`)

```sql
CREATE TABLE prc.cheating_events (                 -- مرتبط بورقة الطالب لا بالطالب (5.2 في BRD)
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL, submission_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('APP_BACKGROUNDED','SCREEN_SPLIT','OVERLAY_DETECTED','SCREENSHOT_ATTEMPT','NETWORK_TOGGLE')), -- [افتراض‑SD] الخمسة
  weight numeric(5,2) NOT NULL, client_event_id uuid NOT NULL,
  occurred_at_client timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb,
  UNIQUE (tenant_id, client_event_id)                -- Idempotency للأحداث المرفوعة offline
);
CREATE TABLE prc.cheating_cases (
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL, submission_id uuid NOT NULL UNIQUE,
  probability numeric(5,2) NOT NULL DEFAULT 0 CHECK (probability BETWEEN 0 AND 100),
  state text NOT NULL DEFAULT 'DETECTED'
    CHECK (state IN ('DETECTED','UNDER_REVIEW','WARNED','REFERRED','CONFIRMED','DISMISSED')),
  version int NOT NULL DEFAULT 1,
  decided_by uuid, decision_reason text, decided_at timestamptz,
  UNIQUE (tenant_id, id)
);
CREATE TABLE prc.warnings (
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL, case_id uuid NOT NULL,
  issued_by uuid NOT NULL, channel text NOT NULL CHECK (channel IN ('LIVE','POST_EXAM')),
  message text NOT NULL, issued_at timestamptz NOT NULL DEFAULT now()
);
```

### 8.11 الدرجات والنتائج (`grd`)

```sql
CREATE TABLE grd.grade_weights (                   -- الموازين: مرتبطة بالتكليف (5.2 في BRD)
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL, assignment_id uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','FINALIZED')),
  finalized_at timestamptz, finalized_by uuid, UNIQUE (tenant_id, id)
);
CREATE TABLE grd.grade_weight_items (
  tenant_id uuid NOT NULL, weights_id uuid NOT NULL,
  component text NOT NULL CHECK (component IN ('ATTENDANCE','ASSIGNMENT','RESEARCH','SEMINAR','MIDTERM','FINAL','PRACTICAL')),
  pct numeric(5,2) NOT NULL CHECK (pct > 0 AND pct <= 100),
  PRIMARY KEY (tenant_id, weights_id, component)
);
-- trigger مؤجَّل (DEFERRABLE INITIALLY DEFERRED) يتحقق أن المجموع = 100 عند FINALIZED

CREATE TABLE grd.coursework_scores (               -- أعمال السنة (FR-ADM-035)
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL, assignment_id uuid NOT NULL,
  student_id uuid NOT NULL, component text NOT NULL, item_ref uuid,   -- schedule_event_id للواجب/البحث
  score numeric(6,2) NOT NULL, max_score numeric(6,2) NOT NULL CHECK (max_score > 0),
  source text NOT NULL CHECK (source IN ('LECTURER','ATTENDANCE_CALC','EXAM')),
  UNIQUE (tenant_id, assignment_id, student_id, component, item_ref)
);
CREATE TABLE grd.exam_results (                    -- يُغذّى من ExamGraded
  tenant_id uuid NOT NULL, exam_id uuid NOT NULL, student_id uuid NOT NULL,
  score numeric(7,2), max_score numeric(7,2) NOT NULL, is_absent boolean NOT NULL DEFAULT false,
  cheating_fail boolean NOT NULL DEFAULT false,      -- من CheatingCaseConfirmed
  PRIMARY KEY (tenant_id, exam_id, student_id)
);
CREATE TABLE grd.final_grades (
  tenant_id uuid NOT NULL, semester_id uuid NOT NULL, course_id uuid NOT NULL, student_id uuid NOT NULL,
  total numeric(6,2) NOT NULL, letter text NOT NULL CHECK (letter IN ('A','B+','B','C+','C','D','F')), -- [افتراض‑SD] سلم التقديرات من SET
  rank int, status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED')),
  published_at timestamptz, breakdown jsonb NOT NULL,
  PRIMARY KEY (tenant_id, semester_id, course_id, student_id)
);
CREATE TABLE grd.grade_publications (              -- نشر عام/مخصص (FR-ADM-030)
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('EXAM','COURSE','SEMESTER')), target_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('PUBLIC','CUSTOM')), audience uuid[], published_by uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE grd.semester_results (
  tenant_id uuid NOT NULL, semester_id uuid NOT NULL, student_id uuid NOT NULL,
  gpa numeric(4,2), standing text, computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, semester_id, student_id)
);
CREATE TABLE grd.transcripts (
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL, student_id uuid NOT NULL,
  semester_id uuid NOT NULL, file_id uuid NOT NULL, generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, student_id, semester_id)
);
```

### 8.12 المالية (`pay`)

```sql
CREATE TABLE pay.payment_gateways (
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL, name text NOT NULL,
  account_details jsonb NOT NULL, active boolean NOT NULL DEFAULT true, UNIQUE (tenant_id, id)
);
CREATE TABLE pay.student_charges (                 -- المستحقات: تُنشأ من StudentEnrolled / بدء الفصل
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL, student_id uuid NOT NULL,
  semester_id uuid, kind text NOT NULL CHECK (kind IN ('TUITION','REGISTRATION','OTHER')),
  amount numeric(14,2) NOT NULL CHECK (amount > 0), due_date date,
  UNIQUE (tenant_id, student_id, semester_id, kind)
);
CREATE TABLE pay.transactions (
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL, student_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('TRANSFER','CASH')),
  gateway_id uuid, amount numeric(14,2) NOT NULL CHECK (amount > 0),
  reference_no text, proof_file_id uuid,
  state text NOT NULL DEFAULT 'SUBMITTED' CHECK (state IN
    ('SUBMITTED','INITIALLY_CONFIRMED','INITIALLY_REJECTED','IN_FINAL_REVIEW','ACCEPTED','REJECTED')),
  version int NOT NULL DEFAULT 1,
  submitted_at timestamptz NOT NULL DEFAULT now(), recorded_by uuid,   -- للنقدي
  UNIQUE (tenant_id, id),
  CHECK (channel = 'CASH' OR (gateway_id IS NOT NULL AND proof_file_id IS NOT NULL))
);
-- منع استخدام نفس إشعار التحويل مرتين (حماية من الاحتيال)
CREATE UNIQUE INDEX uniq_transfer_ref ON pay.transactions (tenant_id, gateway_id, reference_no)
  WHERE reference_no IS NOT NULL AND state NOT IN ('INITIALLY_REJECTED','REJECTED');

CREATE TABLE pay.payment_reviews (                 -- [افتراض‑SD] معنى المراحل الثلاث
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL, transaction_id uuid NOT NULL,
  stage text NOT NULL CHECK (stage IN ('INITIAL','FINAL_1','FINAL_2','FINAL_3')),
  reviewer_id uuid NOT NULL, decision text NOT NULL CHECK (decision IN ('APPROVE','REJECT')),
  notes text, decided_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, transaction_id, stage)
);
CREATE TABLE pay.receipts (
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL, transaction_id uuid NOT NULL UNIQUE,
  receipt_no bigint NOT NULL, file_id uuid, issued_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, receipt_no)                     -- ترقيم متسلسل لكل جامعة عبر جدول counters
);
CREATE TABLE pay.reminder_log (
  tenant_id uuid NOT NULL, student_id uuid NOT NULL, rule_code text NOT NULL, period_key text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, student_id, rule_code, period_key)
);
-- رصيد الطالب = VIEW: sum(charges) - sum(transactions WHERE state='ACCEPTED')
CREATE VIEW pay.v_student_balance AS
SELECT c.tenant_id, c.student_id, sum(c.amount) AS charged,
  coalesce((SELECT sum(t.amount) FROM pay.transactions t WHERE t.tenant_id=c.tenant_id
            AND t.student_id=c.student_id AND t.state='ACCEPTED'),0) AS paid
FROM pay.student_charges c GROUP BY c.tenant_id, c.student_id;
```

الرصيد يُحسب ولا يُخزن، فلا يمكن أن يختلف عن السجل. إذا ظهر بطء لاحقاً يُضاف عمود مُحدَّث بحدث، دون تغيير الواجهة.

### 8.13 التواصل (`cha`، v1.1) والملفات (`fil`) والإشعارات (`not`) والإعدادات (`set`)

```sql
-- CHA
CREATE TABLE cha.chats (id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('DIRECT','GROUP','SUBJECT_CHANNEL')), assignment_id uuid, title text);
CREATE TABLE cha.chat_members (tenant_id uuid NOT NULL, chat_id uuid NOT NULL, user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'MEMBER', last_read_message_id bigint, PRIMARY KEY (tenant_id, chat_id, user_id));
CREATE TABLE cha.messages (id bigint GENERATED ALWAYS AS IDENTITY, tenant_id uuid NOT NULL, chat_id uuid NOT NULL,
  sender_id uuid NOT NULL, body text, file_id uuid, client_msg_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (id, created_at),
  UNIQUE (tenant_id, client_msg_id, created_at)) PARTITION BY RANGE (created_at);
CREATE TABLE cha.support_tickets (id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL,
  opened_by uuid NOT NULL, category text NOT NULL, status text NOT NULL DEFAULT 'OPEN'
  CHECK (status IN ('OPEN','IN_PROGRESS','RESOLVED','CLOSED')), assigned_to uuid, chat_id uuid);
CREATE TABLE cha.announcements (id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('TENANT','PROGRAM','COHORT','ASSIGNMENT')), target_id uuid,
  body text NOT NULL, author_id uuid NOT NULL, published_at timestamptz NOT NULL DEFAULT now());

-- FIL: الملفات الفعلية في krn.files، و FIL يملك الربط والتصنيف
CREATE TABLE fil.file_links (
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL, file_id uuid NOT NULL,
  category text NOT NULL CHECK (category IN ('LECTURE_SLIDES','SHEETS','AUDIO','REFERENCES','PAST_EXAMS','OTHER')), -- [افتراض‑SD] الست
  course_id uuid NOT NULL, assignment_id uuid, event_id uuid,     -- الفئات الثلاث الأولى ترتبط بحدث
  title text NOT NULL, uploaded_by uuid NOT NULL, visibility text NOT NULL DEFAULT 'COHORT',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, file_id) REFERENCES krn.files(tenant_id, id)
);
-- صندوق نتائج الطالب = VIEW على grd.final_grades(PUBLISHED) + grd.transcripts

-- NOT
CREATE TABLE "not".notifications (
  id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL, user_id uuid NOT NULL,
  code text NOT NULL,                                -- 'SY-27', 'AUTH-08'
  category text NOT NULL, priority text NOT NULL CHECK (priority IN ('HIGH','MEDIUM','LOW')),
  title text NOT NULL, body text NOT NULL, action jsonb,           -- زر الإجراء: {route, params}
  source_event_id uuid NOT NULL, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, source_event_id, code)               -- Idempotency: حدث مكرر لا يولّد إشعاراً مكرراً
);
CREATE INDEX ON "not".notifications (tenant_id, user_id, created_at DESC) WHERE read_at IS NULL;
CREATE TABLE "not".notification_preferences (tenant_id uuid NOT NULL, user_id uuid NOT NULL, category text NOT NULL,
  push boolean NOT NULL DEFAULT true, in_app boolean NOT NULL DEFAULT true, PRIMARY KEY (tenant_id, user_id, category));
CREATE TABLE "not".push_tokens (tenant_id uuid NOT NULL, device_id uuid PRIMARY KEY, fcm_token text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now());

-- SET
CREATE TABLE set.tenant_settings (
  tenant_id uuid NOT NULL, section text NOT NULL,    -- [افتراض‑SD] الأقسام العشرة: 'academic','finance','exams','anti_cheat',...
  data jsonb NOT NULL, version int NOT NULL DEFAULT 1, updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, section)
);
CREATE TABLE set.user_settings (tenant_id uuid NOT NULL, user_id uuid NOT NULL, data jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, user_id));
```

كل قسم في `tenant_settings.data` يُتحقق منه بمخطط Zod في الكود قبل الحفظ. الـ jsonb مرن، لكن الكود يتعامل معه بأنواع صارمة.

### 8.14 لوحة القيادة (`dsh`)

لا جداول مملوكة. توجد Materialized Views مثل `dsh.mv_finance_daily` و`dsh.mv_attendance_by_cohort` و`dsh.mv_exam_overview`، يحدّثها الـ worker بـ `REFRESH MATERIALIZED VIEW CONCURRENTLY` كل 10 دقائق، وعند أحداث محددة مع debounce. ملاحظة: الـ MV لا تدعم RLS، فكل استعلام عليها يمر عبر دالة `SECURITY INVOKER` تفلتر بـ `tenant_id` من السياق، ويختبر اختبار تكامل خاص أن هذه الدالة لا تسرّب بيانات.

### 8.15 خريطة العلاقات المختصرة

```
institutions 1─* users 1─1 students *─1 cohorts *─1 programs 1─* courses
                    └─1 lecturers           │
cohorts 1─* semesters 1─* lecturer_assignments *─1 courses
                               │ 1─1 grade_weights 1─* grade_weight_items
                               │ 1─* schedule_events 1─* bookings *─1 facilities
                               │          └─1 attendance_sessions 1─* attendance_records
                               │ 1─* questions
semesters 1─* exam_sessions 1─* exam_questions ; exam_sessions 1─* submissions 1─* submission_answers
submissions 1─* cheating_events ; submissions 1─0..1 cheating_cases 1─* warnings
students 1─* transactions 1─* payment_reviews ; transactions 1─0..1 receipts
semesters 1─0..1 archives
```

---

## 9. آلات الحالات الخمس

### 9.1 المحرّك الموحد

```ts
// src/kernel/fsm/types.ts
export type GuardResult = { ok: true } | { ok: false; code: string; details?: unknown };

export interface TransitionDef<S extends string, C> {
  event: string;                       // 'START_PREPARATION'
  from: readonly S[];
  to: S;
  roles?: readonly Role[];             // من يحق له إطلاق الانتقال
  systemOnly?: boolean;                // worker فقط (مثل AUTO_END)
  guards?: ReadonlyArray<(ctx: GuardCtx<C>) => Promise<GuardResult>>;
  emits?: (ctx: GuardCtx<C>, row: EntityRow<S>) => DomainEvent[];
}

export interface MachineDef<S extends string, C = unknown> {
  name: string;                        // 'semester'
  table: AnyPgTable;                   // adm.semesters
  stateColumn: 'state';
  aggregateType: string;               // 'Semester'
  transitions: readonly TransitionDef<S, C>[];
}

export interface GuardCtx<C> { tx: Tx; tenantId: string; entityId: string; actor: Actor; input: C; now: Date }
```

```ts
// src/kernel/fsm/state-machine.service.ts
@Injectable()
export class StateMachineService {
  constructor(private readonly audit: AuditWriter, private readonly outbox: OutboxWriter, private readonly clock: Clock) {}

  async transition<S extends string, C>(
    def: MachineDef<S, C>,
    p: { tx: Tx; tenantId: string; entityId: string; event: string; actor: Actor; input: C; expectedVersion?: number },
  ): Promise<{ from: S; to: S; version: number }> {
    const { tx } = p;

    // 1) قفل الصف: يمنع انتقالين متزامنين على نفس الكيان
    const row = await tx.execute<EntityRow<S>>(sql`
      SELECT id, state, version FROM ${def.table} WHERE id = ${p.entityId} FOR UPDATE`).then(r => r.rows[0]);
    if (!row) throw new NotFoundError(def.aggregateType, p.entityId);

    // 2) Optimistic concurrency اختياري: العميل يرسل النسخة التي رآها
    if (p.expectedVersion !== undefined && p.expectedVersion !== row.version)
      throw new ConflictError('STALE_VERSION', { current: row.version });

    // 3) هل الانتقال معرّف من هذه الحالة؟
    const t = def.transitions.find(x => x.event === p.event && x.from.includes(row.state));
    if (!t) throw new InvalidTransitionError(def.name, row.state, p.event);

    // 4) الصلاحية
    if (t.systemOnly && p.actor.kind !== 'SYSTEM') throw new ForbiddenError('SYSTEM_ONLY_TRANSITION');
    if (t.roles && p.actor.kind === 'USER' && !t.roles.includes(p.actor.role)) throw new ForbiddenError('ROLE_NOT_ALLOWED');

    // 5) الشروط المسبقة: كلها تُنفَّذ وتُجمع الأسباب (FR-ADM-034: رسالة دقيقة لا عامة)
    const now = this.clock.now();
    const ctx: GuardCtx<C> = { tx, tenantId: p.tenantId, entityId: p.entityId, actor: p.actor, input: p.input, now };
    const failures = (await Promise.all((t.guards ?? []).map(g => g(ctx)))).filter(r => !r.ok);
    if (failures.length) throw new PreconditionFailedError(failures);

    // 6) فتح البوابة لـ trigger قاعدة البيانات، ثم التحديث المشروط، ثم إغلاق البوابة
    await tx.execute(sql`select set_config('app.fsm', ${def.name}, true)`);
    const upd = await tx.execute(sql`
      UPDATE ${def.table} SET state = ${t.to}, version = version + 1, state_changed_at = ${now}
      WHERE id = ${p.entityId} AND state = ${row.state} RETURNING version`);
    await tx.execute(sql`select set_config('app.fsm', '', true)`);
    if (upd.rowCount !== 1) throw new ConflictError('CONCURRENT_TRANSITION');

    // 7) التدقيق والحدث في نفس المعاملة
    await this.audit.write(tx, {
      tenantId: p.tenantId, actor: p.actor, action: 'fsm.transition',
      entityType: def.aggregateType, entityId: p.entityId,
      before: { state: row.state }, after: { state: t.to, event: p.event },
    });
    const events: DomainEvent[] = [
      { type: `${def.name}.StateChanged.v1`, aggregateType: def.aggregateType, aggregateId: p.entityId,
        payload: { from: row.state, to: t.to, event: p.event, by: p.actor.id ?? 'SYSTEM' } },
      ...(t.emits?.(ctx, { ...row, state: t.to }) ?? []),
    ];
    await this.outbox.append(tx, p.tenantId, events);

    return { from: row.state, to: t.to, version: row.version + 1 };
  }
}
```

### 9.2 تعريفات الآلات

**الأولى: دورة حياة الفصل الدراسي.** أضفت حالة طرفية داخلية هي `ARCHIVED`، لا تظهر في الواجهة. السبب أن الواجهة تعرض أربع مراحل، لكن البيانات تحتاج أن تفرّق بين فصل انتهى وأُرشف وبين خمول في انتظار الفصل التالي. بعد الأرشفة تنتقل الدفعة إلى فصل جديد بحالة IDLE.

```ts
// src/modules/adm/domain/semester.machine.ts
export type SemesterState = 'IDLE' | 'PREPARATION' | 'IN_PROGRESS' | 'RESULTS' | 'ARCHIVED';

export const semesterMachine: MachineDef<SemesterState> = {
  name: 'semester', table: semesters, stateColumn: 'state', aggregateType: 'Semester',
  transitions: [
    { event: 'START_PREPARATION', from: ['IDLE'], to: 'PREPARATION', roles: ['ADMIN_MAIN', 'ADMIN_SUB'] },
    {
      event: 'START_TEACHING', from: ['PREPARATION'], to: 'IN_PROGRESS', roles: ['ADMIN_MAIN', 'ADMIN_SUB'],
      guards: [allCoursesHaveLecturer],                     // FR-ADM-024
      emits: (c) => [{ type: 'adm.SemesterStarted.v1', aggregateType: 'Semester', aggregateId: c.entityId, payload: {} }],
    },
    {
      event: 'START_RESULTS', from: ['IN_PROGRESS'], to: 'RESULTS', roles: ['ADMIN_MAIN'],
      guards: [noLiveExams],
    },
    {
      event: 'ARCHIVE', from: ['RESULTS'], to: 'ARCHIVED', roles: ['ADMIN_MAIN'],
      guards: [semesterResultsCollected],                  // FR-ADM-033/034
      emits: (c) => [{ type: 'adm.SemesterArchiveRequested.v1', aggregateType: 'Semester', aggregateId: c.entityId, payload: {} }],
    },
  ],
};

// guard يعيد أسباباً دقيقة: "مادة X ينقصها مكوّن MIDTERM"
async function semesterResultsCollected(c: GuardCtx<unknown>): Promise<GuardResult> {
  const missing = await c.tx.execute<{ course: string; component: string }>(sql`
    SELECT co.name AS course, wi.component
    FROM adm.lecturer_assignments la
    JOIN adm.courses co ON co.id = la.course_id
    JOIN grd.grade_weights w ON w.assignment_id = la.id
    JOIN grd.grade_weight_items wi ON wi.weights_id = w.id
    WHERE la.semester_id = ${c.entityId} AND la.unassigned_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM grd.final_grades fg
                      WHERE fg.semester_id = la.semester_id AND fg.course_id = la.course_id)`);
  return missing.rows.length ? { ok: false, code: 'MISSING_COMPONENTS', details: missing.rows } : { ok: true };
}
```

ملاحظة على الحدود: هذا الـ guard يقرأ من `grd` مباشرة، وهذا خرق لقاعدة الحدود. الحل الصحيح أن يستدعي `GrdFacade.getMissingComponents(semesterId)`، ويمرر لها `tx` حتى تقرأ داخل نفس المعاملة. كتبت SQL هنا للتوضيح فقط، والقاعدة في الكود الفعلي أن الـ guards التي تحتاج بيانات وحدة أخرى تستدعي Facade.

**الثانية: المعاملة المالية.** المراحل الثلاث للمراجعة النهائية مسجلة كبيانات في `payment_reviews`، والآلة تشترط اكتمالها. لهذا يبقى التصميم صحيحاً أياً كان معنى المراحل الثلاث في BRD **[افتراض‑SD]**.

```ts
export type TxState = 'SUBMITTED' | 'INITIALLY_CONFIRMED' | 'INITIALLY_REJECTED' | 'IN_FINAL_REVIEW' | 'ACCEPTED' | 'REJECTED';

export const paymentMachine: MachineDef<TxState, { notes?: string }> = {
  name: 'payment', table: transactions, stateColumn: 'state', aggregateType: 'Transaction',
  transitions: [
    { event: 'CONFIRM_INITIAL', from: ['SUBMITTED'], to: 'INITIALLY_CONFIRMED',
      roles: ['ADMIN_MAIN', 'ADMIN_SUB'], guards: [hasPanelPermission('pay.initial', 'WRITE'), proofFileReady] },
    { event: 'REJECT_INITIAL', from: ['SUBMITTED'], to: 'INITIALLY_REJECTED',
      roles: ['ADMIN_MAIN', 'ADMIN_SUB'], guards: [requireNotes],
      emits: (c) => [ev('pay.PaymentRejected.v1', c, { stage: 'INITIAL' })] },
    { event: 'OPEN_FINAL_REVIEW', from: ['INITIALLY_CONFIRMED'], to: 'IN_FINAL_REVIEW', roles: ['ADMIN_MAIN'] },
    { event: 'ACCEPT', from: ['IN_FINAL_REVIEW'], to: 'ACCEPTED', roles: ['ADMIN_MAIN'],
      guards: [allFinalStagesApproved /* FINAL_1..3 = APPROVE */],
      emits: (c) => [ev('pay.PaymentAccepted.v1', c, {})] },   // ← يولّد الإيصال + يُبطل كاش الرصيد + إشعار
    { event: 'REJECT_FINAL', from: ['IN_FINAL_REVIEW'], to: 'REJECTED', roles: ['ADMIN_MAIN'], guards: [requireNotes],
      emits: (c) => [ev('pay.PaymentRejected.v1', c, { stage: 'FINAL' })] },
  ],
};
// المعاملة النقدية تُنشأ مباشرة بحالة INITIALLY_CONFIRMED (المسجِّل هو المؤكِّد المبدئي)
```

**الثالثة: جلسة الامتحان.**

```ts
export type ExamState = 'DRAFT'|'REQUESTED'|'SCHEDULED'|'READY'|'LIVE'|'ENDED'|'GRADING'|'GRADED'|'PUBLISHED'|'CANCELLED';

export const examMachine: MachineDef<ExamState> = {
  name: 'exam', table: examSessions, stateColumn: 'state', aggregateType: 'ExamSession',
  transitions: [
    { event: 'REQUEST',  from: ['DRAFT'], to: 'REQUESTED', roles: ['ADMIN_MAIN','ADMIN_SUB','LECTURER'] },
    { event: 'SCHEDULE', from: ['REQUESTED'], to: 'SCHEDULED', roles: ['ADMIN_MAIN','ADMIN_SUB'],
      guards: [hasTimeWindow, hasFacilityBookingUnlessOnlineRemote, hasProctorAccesses, weightsFinalized] },
    { event: 'CONFIRM_CONTENT', from: ['SCHEDULED'], to: 'READY', roles: ['LECTURER'],
      guards: [isAssignedLecturer, contentPresentForKind /* ONLINE: أسئلة؛ PAPER: pdf */],
      emits: (c) => [ev('exm.ExamReady.v1', c, {})] },           // ← worker يجدول START و END
    { event: 'START', from: ['READY'], to: 'LIVE', systemOnly: true, guards: [nowWithinStartWindow],
      emits: (c) => [ev('exm.ExamSessionStarted.v1', c, {})] },  // ← PRC يفتح الرصد
    { event: 'END', from: ['LIVE'], to: 'ENDED', systemOnly: true,
      emits: (c) => [ev('exm.ExamSessionEnded.v1', c, {})] },    // ← auto-submit للمتبقين
    { event: 'BEGIN_GRADING', from: ['ENDED'], to: 'GRADING', roles: ['LECTURER','ADMIN_MAIN','ADMIN_SUB'] },
    { event: 'COMPLETE_GRADING', from: ['GRADING'], to: 'GRADED', roles: ['LECTURER'],
      guards: [allAnswersScored, noPendingAiReview],
      emits: (c) => [ev('exm.ExamGraded.v1', c, {})] },          // ← GRD
    { event: 'PUBLISH', from: ['GRADED'], to: 'PUBLISHED', roles: ['ADMIN_MAIN','ADMIN_SUB'],
      guards: [noOpenCheatingCases],
      emits: (c) => [ev('grd.GradesPublished.v1', c, {})] },     // ← إبطال كاش + إشعار
    { event: 'CANCEL', from: ['DRAFT','REQUESTED','SCHEDULED','READY'], to: 'CANCELLED', roles: ['ADMIN_MAIN'],
      emits: (c) => [ev('exm.ExamCancelled.v1', c, {})] },       // ← FAC يلغي الحجز
  ],
};
```

حالة كل ورقة طالب (`submissions.status`) لا تحتاج آلة كاملة. تُدار بتحديثات مشروطة ذرية مثل `UPDATE ... SET status='AUTO_SUBMITTED' WHERE status='IN_PROGRESS'`، فيكون التسليم التلقائي Idempotent بطبيعته.

**الرابعة: جلسة الحضور.**

```ts
export type AttState = 'SCHEDULED'|'OPEN'|'CLOSED'|'UNDER_ARBITRATION'|'FINALIZED'|'CANCELLED';

export const attendanceMachine: MachineDef<AttState> = {
  name: 'attendance', table: attendanceSessions, stateColumn: 'state', aggregateType: 'AttendanceSession',
  transitions: [
    { event: 'OPEN', from: ['SCHEDULED'], to: 'OPEN', roles: ['LECTURER'],
      guards: [isEventLecturer, withinOpenWindow, assistantsAssignedIfBluetooth] },
    { event: 'CLOSE', from: ['OPEN'], to: 'CLOSED', roles: ['LECTURER'] },
    { event: 'AUTO_CLOSE', from: ['OPEN'], to: 'CLOSED', systemOnly: true },        // بعد نهاية الحدث + هامش
    { event: 'REQUIRE_ARBITRATION', from: ['CLOSED'], to: 'UNDER_ARBITRATION', systemOnly: true,
      guards: [hasDisputedRecords] },
    { event: 'FINALIZE', from: ['CLOSED','UNDER_ARBITRATION'], to: 'FINALIZED', roles: ['LECTURER'],
      guards: [noDisputedRecords],
      emits: (c) => [ev('att.AttendanceFinalized.v1', c, {})] },                   // ← GRD + إبطال كاش
    { event: 'CANCEL', from: ['SCHEDULED','OPEN'], to: 'CANCELLED', roles: ['LECTURER','ADMIN_MAIN'] },
  ],
};
```

**الخامسة: حالة الغش.** حسب RACI في BRD، المحاضر والمراقب يُستشارون فقط، والإداري الرئيسي هو صاحب قرار التثبيت.

```ts
export type CaseState = 'DETECTED'|'UNDER_REVIEW'|'WARNED'|'REFERRED'|'CONFIRMED'|'DISMISSED';

export const cheatingMachine: MachineDef<CaseState, { reason?: string }> = {
  name: 'cheating', table: cheatingCases, stateColumn: 'state', aggregateType: 'CheatingCase',
  transitions: [
    { event: 'ESCALATE', from: ['DETECTED'], to: 'UNDER_REVIEW', systemOnly: true,
      guards: [probabilityAboveReviewThreshold] },                                // العتبة من SET
    { event: 'WARN',  from: ['DETECTED','UNDER_REVIEW'], to: 'WARNED', roles: ['ADMIN_MAIN','ADMIN_SUB'] },
    { event: 'REFER', from: ['UNDER_REVIEW','WARNED'], to: 'REFERRED', roles: ['ADMIN_MAIN','ADMIN_SUB','LECTURER'] },
    { event: 'CONFIRM', from: ['REFERRED'], to: 'CONFIRMED', roles: ['ADMIN_MAIN'], guards: [requireReason],
      emits: (c) => [ev('prc.CheatingCaseConfirmed.v1', c, {})] },               // ← GRD: cheating_fail
    { event: 'DISMISS', from: ['DETECTED','UNDER_REVIEW','WARNED','REFERRED'], to: 'DISMISSED',
      roles: ['ADMIN_MAIN'], guards: [requireReason] },
  ],
};
```

النقطة الأهم هنا: لا يوجد أي انتقال تلقائي إلى `CONFIRMED`، أي لا عقوبة آلية. هذا يعالج مخاوف الطالب ST-07 مباشرة.

### 9.3 الحماية في قاعدة البيانات

```sql
CREATE FUNCTION krn.enforce_fsm() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE machine text := TG_ARGV[0];
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF coalesce(current_setting('app.fsm', true), '') <> machine THEN
      RAISE EXCEPTION 'FSM_BYPASS: direct state change on % is forbidden', TG_TABLE_NAME
        USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM krn.fsm_transitions
                   WHERE machine = TG_ARGV[0] AND from_state = OLD.state AND to_state = NEW.state) THEN
      RAISE EXCEPTION 'FSM_ILLEGAL: % -> % on %', OLD.state, NEW.state, machine USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fsm_guard BEFORE UPDATE OF state ON adm.semesters
  FOR EACH ROW EXECUTE FUNCTION krn.enforce_fsm('semester');
-- ونفس الشيء لـ pay.transactions('payment'), exm.exam_sessions('exam'),
-- att.attendance_sessions('attendance'), prc.cheating_cases('cheating')
```

جدول `krn.fsm_transitions` يُملأ تلقائياً من تعريفات TypeScript عبر سكربت `pnpm fsm:sync`، ويوجد اختبار CI يفشل إذا اختلف الجدول عن التعريفات. بهذا يصبح للآلة مصدر حقيقة واحد في الكود، تفرضه قاعدة البيانات أيضاً.

---

## 10. الأحداث وTransactional Outbox

### 10.1 كتابة الحدث

```ts
// src/kernel/outbox/outbox.writer.ts
export class OutboxWriter {
  async append(tx: Tx, tenantId: string, events: DomainEvent[]) {
    if (!events.length) return;
    await tx.insert(eventsOutbox).values(events.map(e => ({
      tenantId, eventType: e.type, aggregateType: e.aggregateType,
      aggregateId: e.aggregateId, payload: e.payload,
    })));
    await tx.execute(sql`select pg_notify('outbox_new', '')`);   // يُسلَّم فقط بعد COMMIT
  }
}
```

`pg_notify` داخل المعاملة لا يُرسل إلا بعد COMMIT. إذا فشلت المعاملة لا يصل الإشعار ولا يبقى الحدث، وهذا هو السلوك المطلوب.

### 10.2 الناشر (Relay) في الـ worker

```ts
// src/kernel/outbox/outbox.relay.ts
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap {
  private draining = false;
  constructor(private readonly db: Db, private readonly directPg: DirectPgClient,
              private readonly registry: EventHandlerRegistry, private readonly q: QueueFactory) {}

  async onApplicationBootstrap() {
    await this.directPg.query('LISTEN outbox_new');               // اتصال مباشر (ADR‑N5)
    this.directPg.on('notification', () => void this.drain());
    setInterval(() => void this.drain(), 2_000);                  // شبكة أمان لو فُقد NOTIFY
  }

  private async drain() {
    if (this.draining) return; this.draining = true;
    try {
      for (;;) {
        const n = await this.db.transaction(async (tx) => {
          const batch = await tx.execute<OutboxRow>(sql`
            SELECT * FROM krn.events_outbox WHERE published_at IS NULL
            ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`);
          for (const e of batch.rows) {
            const handlers = this.registry.handlersFor(e.event_type);  // NOT يستمع لكل شيء
            for (const h of handlers) {
              await this.q.get('events').add(h.name, e, {
                jobId: `${e.event_id}:${h.name}`,                      // BullMQ يتجاهل jobId المكرر
                attempts: 8, backoff: { type: 'exponential', delay: 1_000 },
                removeOnComplete: 1_000, removeOnFail: 5_000,
              });
            }
            await tx.execute(sql`UPDATE krn.events_outbox SET published_at = now() WHERE id = ${e.id}`);
          }
          return batch.rows.length;
        });
        if (n < 100) break;
      }
    } finally { this.draining = false; }
  }
}
```

إذا سقط الـ worker بعد الإضافة إلى BullMQ وقبل COMMIT، يُعاد نشر الحدث في الدورة التالية، ويمنع `jobId` الثابت تكرار المهمة. وإذا تكررت المهمة لأي سبب آخر، تكفي طبقة الـ idempotency في المستمع (10.3). هذا هو معنى At-Least-Once مع معالجة فعالة لمرة واحدة.

### 10.3 مستمع Idempotent

```ts
// src/kernel/outbox/idempotent-handler.ts
export function IdempotentHandler(name: string, eventTypes: string[] | '*') { /* decorator يسجّل في registry */ }

export async function runOnce(tx: Tx, handler: string, eventId: string, fn: () => Promise<void>) {
  const inserted = await tx.execute(sql`
    INSERT INTO krn.processed_events (handler, event_id) VALUES (${handler}, ${eventId})
    ON CONFLICT DO NOTHING RETURNING 1`);
  if (inserted.rowCount === 0) return;          // عولج من قبل
  await fn();                                   // الأثر الجانبي + سجل المعالجة في نفس المعاملة
}

// مثال: GRD يستمع لـ ExamGraded
@IdempotentHandler('grd.onExamGraded', ['exm.ExamGraded.v1'])
export class OnExamGraded {
  constructor(private readonly tt: TenantTx, private readonly exm: ExmFacade) {}
  async handle(e: OutboxRow) {
    await this.tt.run(tx => runOnce(tx, 'grd.onExamGraded', e.event_id, async () => {
      const scores = await this.exm.getSubmissionScores(tx, e.aggregate_id);
      await upsertExamResults(tx, e.aggregate_id, scores);
    }), { tenantId: e.tenant_id });
  }
}
```

### 10.4 كتالوج الأحداث الأساسي

| الحدث | المُصدِر | المستمعون (عدا NOT الذي يستمع للكل) |
|---|---|---|
| `adm.StudentActivated` / `StudentDeactivated` | ADM | OWN (العدّاد)، PAY (المستحقات) |
| `adm.StudentEnrolled` | ADM | PAY |
| `adm.DocumentVerified` / `DocumentRejected` | ADM | AUTH (رفع تقييد الوصول) |
| `adm.LecturerAssigned` | ADM | FAC، CHA (قناة المادة، v1.1) |
| `adm.SemesterStarted` | ADM | PAY (مستحقات الفصل)، CacheInvalidator |
| `adm.SemesterArchiveRequested` | ADM | Worker: ArchiveBuilder |
| `fac.ScheduleConfirmed` / `ScheduleChanged` | FAC | ATT (إنشاء الجلسات)، CacheInvalidator |
| `grd.WeightsFinalized` | GRD | EXM |
| `exm.ExamReady` | EXM | Worker: جدولة START/END |
| `exm.ExamSessionStarted` / `Ended` | EXM | PRC، ATT (جلسة باركود) |
| `exm.ExamSubmitted` | EXM | CHT (v1.1) |
| `exm.ExamGraded` | EXM | GRD |
| `att.AttendanceFinalized` | ATT | GRD، CacheInvalidator |
| `prc.CheatingCaseConfirmed` | PRC | GRD، EXM |
| `pay.PaymentAccepted` / `Rejected` | PAY | Worker: ReceiptGenerator، EXM (إعادة حساب الأهلية)، CacheInvalidator |
| `grd.GradesPublished` | GRD/EXM | FIL (صندوق النتائج)، CacheInvalidator |

قاعدة الإصدارات: اسم الحدث يحمل `.v1`. إذا تغير شكل الـ payload بشكل غير متوافق يُنشر `.v2` بجانبه حتى تُرحَّل كل المستمعات.

### 10.5 تنظيف الـ outbox

مهمة يومية تحذف صفوف `events_outbox` المنشورة منذ أكثر من 7 أيام، وصفوف `processed_events` الأقدم من 14 يوماً. سجل التدقيق هو السجل الدائم، أما الـ outbox فقناة نقل فقط.

---

## 11. عقد Idempotency للعمل دون اتصال

### 11.1 العقد

| البند | القيمة |
|---|---|
| المسارات | `POST /att/sessions/:id/uploads`، و`PUT /exm/submissions/:id/answers` (دفعة)، و`POST /prc/submissions/:id/events` (دفعة) |
| الترويسة | `Idempotency-Key: <uuidv7>` إلزامية لهذه المسارات، وغيابها يعيد `400` |
| التوليد | يولّد العميل المفتاح **لحظة وقوع الفعل محلياً**، ويحفظه مع الحمولة في Hive قبل أي محاولة إرسال |
| البصمة | `request_hash = sha256(method + route + canonical_json(body))` |
| النافذة | 48 ساعة (`expires_at`)، ثم يحذفها الـ worker |
| مفتاح بنفس البصمة وقد اكتمل | يُعاد الرد المخزن نفسه مع ترويسة `Idempotent-Replayed: true` |
| مفتاح ببصمة مختلفة | `422 IDEMPOTENCY_KEY_REUSED` (خطأ في العميل، لا يُعاد إرساله) |
| مفتاح قيد المعالجة | `409 IN_PROGRESS` مع `Retry-After: 2` |
| أخطاء 5xx | لا تُخزن، فيُسمح بإعادة المحاولة بنفس المفتاح |

### 11.2 الـ Interceptor

```ts
// src/kernel/idempotency/idempotency.interceptor.ts
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly db: Db, private readonly cls: ClsService) {}

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const key = req.header('Idempotency-Key');
    if (!key || !isUuid(key)) throw new BadRequestException('IDEMPOTENCY_KEY_REQUIRED');

    const tenantId = this.cls.get('tenantId'); const userId = this.cls.get('userId');
    const route = `${req.method} ${req.route.path}`;
    const hash = sha256(`${route}\n${canonicalJson(req.body)}`);

    // 1) حجز المفتاح ذرياً (معاملة قصيرة مستقلة)
    const claim = await withTenant(this.db, tenantId, tx => tx.execute<{ inserted: boolean } & IdemRow>(sql`
      WITH ins AS (
        INSERT INTO krn.idempotency_keys (tenant_id, key, user_id, route, request_hash, status)
        VALUES (${tenantId}, ${key}, ${userId}, ${route}, ${hash}, 'IN_PROGRESS')
        ON CONFLICT (tenant_id, key) DO NOTHING RETURNING true AS inserted)
      SELECT (SELECT inserted FROM ins) AS inserted, k.*
      FROM krn.idempotency_keys k WHERE k.tenant_id = ${tenantId} AND k.key = ${key}`));
    const row = claim.rows[0];

    if (!row.inserted) {
      if (row.user_id !== userId || !row.request_hash.equals(hash)) throw new UnprocessableEntityException('IDEMPOTENCY_KEY_REUSED');
      if (row.status === 'IN_PROGRESS') { res.setHeader('Retry-After', '2'); throw new ConflictException('IN_PROGRESS'); }
      res.status(row.response_code!); res.setHeader('Idempotent-Replayed', 'true');
      return of(row.response_body);
    }

    // 2) التنفيذ: الـ handler يكتب أثره، ثم نخزّن الرد
    return next.handle().pipe(
      mergeMap(async (body) => {
        await withTenant(this.db, tenantId, tx => tx.execute(sql`
          UPDATE krn.idempotency_keys SET status='COMPLETED', response_code=${res.statusCode}, response_body=${body}
          WHERE tenant_id=${tenantId} AND key=${key}`));
        return body;
      }),
      catchError(async (err) => {
        const status = err?.getStatus?.() ?? 500;
        await withTenant(this.db, tenantId, tx => status >= 500
          ? tx.execute(sql`DELETE FROM krn.idempotency_keys WHERE tenant_id=${tenantId} AND key=${key}`)
          : tx.execute(sql`UPDATE krn.idempotency_keys SET status='COMPLETED', response_code=${status},
                           response_body=${{ error: err.message }} WHERE tenant_id=${tenantId} AND key=${key}`));
        throw err;
      }),
    );
  }
}
```

هناك فجوة صغيرة: إذا نجح الـ handler ثم سقط الخادم قبل تحديث المفتاح إلى COMPLETED، يبقى المفتاح IN_PROGRESS. لهذا تحمل المسارات الثلاثة قيداً فريداً ثانياً على مستوى البيانات نفسها، هو `attendance_uploads.idempotency_key` و`cheating_events.client_event_id` و`client_seq` في الإجابات. ومهمة دورية تحذف المفاتيح العالقة في IN_PROGRESS لأكثر من 5 دقائق، فتنجح إعادة المحاولة التالية دون تكرار البيانات. وبهذا تكون الحماية مزدوجة.

### 11.3 الحفظ التلقائي لإجابات الامتحان

```ts
// PUT /exm/submissions/:id/answers  body: { answers: [{ questionId, answer, clientSeq, clientSavedAt }] }
async saveAnswers(tx: Tx, submissionId: string, studentId: string, items: AnswerDto[], receivedAt: Date) {
  const sub = await lockSubmission(tx, submissionId, studentId);         // FOR UPDATE
  const grace = sub.settings.offlineGraceSeconds ?? 600;                 // من SET (افتراضي 10 دقائق)

  if (sub.status === 'IN_PROGRESS' && receivedAt > sub.server_deadline) {
    // الخادم هو المرجع: إذا لم يكن التسليم التلقائي قد جرى بعد، ننفّذه الآن
    await autoSubmit(tx, sub);
  }
  const late = receivedAt > sub.server_deadline;
  if (late && receivedAt > addSeconds(sub.server_deadline, grace)) throw new GoneException('DEADLINE_PASSED');

  for (const a of items) {
    // الأحدث (clientSeq) يفوز؛ وصول نسخة أقدم متأخراً لا يطغى على نسخة أحدث
    await tx.execute(sql`
      INSERT INTO exm.submission_answers (tenant_id, submission_id, question_id, answer, client_seq, client_saved_at)
      VALUES (${sub.tenant_id}, ${submissionId}, ${a.questionId}, ${a.answer}, ${a.clientSeq}, ${a.clientSavedAt})
      ON CONFLICT (tenant_id, submission_id, question_id) DO UPDATE
        SET answer = EXCLUDED.answer, client_seq = EXCLUDED.client_seq,
            client_saved_at = EXCLUDED.client_saved_at, received_at = now()
        WHERE exm.submission_answers.client_seq < EXCLUDED.client_seq`);
  }
  if (late) await markLateSynced(tx, submissionId);                     // يظهر للمحاضر كعلامة مراجعة
}
```

إجابات الامتحان الأونلاين تُقبل متأخرة فقط إذا وصلت خلال نافذة السماح بعد الموعد، وتُعلَّم `late_synced` ليراجعها المحاضر. السبب أن وقت جهاز الطالب غير موثوق، فلا يُعتمد عليه وحده لإثبات أن الإجابة كُتبت قبل نهاية الوقت. ويُحسب `clientSeq` كعدّاد رتيب داخل التطبيق لا من ساعة الجهاز.

### 11.4 مزامنة الساعة في العميل

`GET /api/v1/time` يعيد `{ serverNow, examDeadline? }`. يحسب العميل الفرق `offset = serverNow - (t0 + rtt/2)`، ويعرض العدّاد التنازلي بناءً عليه. ويُعاد الحساب عند كل حفظ ناجح. أما القرار النهائي فدائماً في الخادم.

---

## 12. العمليات الخلفية (Worker) والطوابير

| الطابور | المهمة | التزامن | المحاولات | ملاحظات |
|---|---|---|---|---|
| `events` | توزيع الأحداث على المستمعين | 8 | 8، تصاعدي | jobId = `event:handler` |
| `exam-clock` | START وEND المؤجلان لكل امتحان | 4 | 5 | `delay` محسوب من `starts_at`/`ends_at`، وjobId = `exam:{id}:END` |
| `ai-grading` (v1.1) | تصحيح سؤال واحد | 2 | 3 | Timeout 60 ثانية، وبعد الفشل `FALLBACK_MANUAL` |
| `archive` | بناء أرشيف الفصل | 1 | 3 | الأثقل ذاكرة، ويعمل منفرداً |
| `documents` | PDF (إيصال، كشف درجات) وExcel | 2 | 3 | |
| `import` | الاستيراد الجماعي | 1 | 1 | مرحلتان: dry-run ثم تنفيذ (FR-ADM-018) |
| `scheduled` (repeatable) | التذكير المالي، تحديث MV، إنشاء أقسام audit، التنظيف، لقطة الفوترة اليومية | 1 | 3 | cron |

### 12.1 التسليم التلقائي لنهاية الامتحان (طبقتان)

```ts
// عند ExamReady: جدولة END بدقة
await queues.get('exam-clock').add('END', { tenantId, examId }, {
  jobId: `exam:${examId}:END`, delay: Math.max(0, endsAt.getTime() - Date.now()),
});

// المعالج: انتقال الآلة + تسليم كل الأوراق المفتوحة ذرياً
async function onExamEnd({ tenantId, examId }) {
  await tenantTx.run(async (tx) => {
    await fsm.transition(examMachine, { tx, tenantId, entityId: examId, event: 'END', actor: SYSTEM, input: {} })
      .catch(ignoreIf(InvalidTransitionError));            // أُنهي من قبل: لا مشكلة
    const subs = await tx.execute(sql`
      UPDATE exm.submissions SET status='AUTO_SUBMITTED', submitted_at=now()
      WHERE exam_id=${examId} AND status='IN_PROGRESS' RETURNING id`);
    await outbox.append(tx, tenantId, subs.rows.map(s => ev('exm.ExamSubmitted.v1', s.id, { auto: true })));
  }, { tenantId });
}
```

الطبقة الثانية مهمة `scheduled` تعمل كل دقيقة: `SELECT id FROM exm.exam_sessions WHERE state='LIVE' AND ends_at < now() - interval '1 minute'` وتنفذ نفس المعالج. فإذا فُقدت المهمة المؤجلة لأي سبب، يكون أقصى تأخير دقيقة واحدة.

ولكل ورقة طالب موعد خاص `server_deadline = min(started_at + duration, ends_at)`. فحص الموعد يتم عند كل حفظ، ولا يحتاج مهمة لكل طالب.

### 12.2 خط تصحيح الذكاء الاصطناعي (v1.1)

```
ExamSubmitted ─▶ CHT: إنشاء grading_jobs لكل سؤال SHORT/ESSAY/DIAGRAM (UNIQUE يمنع التكرار)
   ─▶ ai-grading: بناء prompt (السؤال + تعليمات المحاضر + الإجابة، بلا اسم أو رقم الطالب)
       ├─ نجح ─▶ ai_grading_results(suggested) ─▶ score_source='AI_SUGGESTED'
       └─ فشل 3 مرات / timeout ─▶ FALLBACK_MANUAL ─▶ يظهر في قائمة التصحيح اليدوي
COMPLETE_GRADING guard: لا يوجد AI_SUGGESTED غير مُراجَع بشرياً
```

وفيه Circuit Breaker بسيط: إذا فشل أكثر من 50% من آخر 20 مهمة، يتوقف الطابور 10 دقائق ويُرسل إشعار للمشغّل، بدل استهلاك المحاولات على مزود معطّل.

### 12.3 بناء الأرشيف

يُبنى الأرشيف بالتدفق (streaming) حتى لا يُحمّل كاملاً في الذاكرة. الـ worker يقرأ من Postgres بمؤشر (cursor)، ويكتب CSV وJSON، ويجلب الملفات من التخزين، ويمرر كل ذلك إلى `archiver` بتشفير AES-256 (zip-encrypted)، ثم يرفع الناتج مباشرة إلى التخزين بالرفع متعدد الأجزاء. كلمة السر 32 بايت عشوائية، تُشفَّر بالمفتاح الرئيسي (KEK من ملف سري على الخادم وخارج قاعدة البيانات) وتُخزن في `archives.wrapped_key`. الملفات المرئية (فيديو) مستثناة حسب FR-ADM-042 وSC-OUT-06، وبيانات الطلاب ووثائقهم تُخزن في مجلد الدفعة لا الفصل (FR-ADM-043). القراءة الأونلاين للأرشيف تتم بفك التشفير في الخادم وعرض الملفات للقراءة فقط.

---

## 13. القنوات اللحظية (WebSocket)

| الـ Namespace | المستخدمون | الغرف | الرسائل الرئيسية |
|---|---|---|---|
| `/ws/proctor` | المراقب (ويب)، والإداري | `exam:{id}` | `cheating.event`، `submission.status`، `attendance.scan`، `warning.issue` (من المراقب) |
| `/ws/notifications` | الكل | `user:{id}` | `notification.new`، `badge.count` |
| `/ws/chat` (v1.1) | الكل | `chat:{id}` | `message.new`، `typing`، `read` |

المصادقة: يرسل العميل الـ JWT في `auth` عند المصافحة، ويتحقق منه نفس `AuthGuard` ثم `TenantGuard` ثم `RoleGuard` بنسخة WS. كل اسم غرفة يبدأ داخلياً بـ `t:{tenantId}:`، فلا يمكن الانضمام إلى غرفة جامعة أخرى حتى بمعرف صحيح. التوزيع عبر `@socket.io/redis-adapter` على `redis-core`، فيجهز التصميم لتعدد نسخ الـ api دون تغيير.

المبدأ: الـ WebSocket للإشعار والعرض فقط ولا يحمل أي كتابة مهمة. أحداث الغش ترفع عبر REST بعقد Idempotency (القسم 11)، ثم تُبث للمراقب عبر WS. فإذا انقطع الـ WS لا يضيع أي شيء.

حساب نسبة احتمالية الغش: `probability = min(100, Σ weight_i × decay(t_i))`، والأوزان من إعدادات `anti_cheat` **[افتراض‑SD]**. تُحسب في المعاملة نفسها التي تُدخل الحدث، ثم يُبث التحديث.

---

## 14. طبقة الكاش

اعتمدت وثيقة "Cache Distribution and Logical Isolation" كأساس لهذا القسم، مع ثلاثة تعديلات: البادئة صارت `ah` بدل `ucs` لتطابق اسم المشروع، والكاش يعمل على `redis-cache` فقط (ADR‑N1)، وصار لكل مدخل في `common` وحدة مالكة واحدة مسؤولة عن كتابته وإبطاله.

### 14.1 صيغة المفتاح

```
ah:{tenantCode}:{namespace}:{resource}:{identifier}[:v{gen}]
مثال:  ah:uofk:fac:cohort_schedule:0191f...:w2026-41
       ah:uofk:common:settings:exams
```

`namespace` هو رمز الوحدة بحروف صغيرة (`fac` و`grd` و`fil`...) أو `common`. المفاتيح العامة مثل `student:123` ممنوعة.

### 14.2 ما يُكاش وما لا يُكاش

| المورد | المالك | المفتاح | TTL (شبكة أمان) | يُبطَل بحدث |
|---|---|---|---|---|
| جدول الدفعة الأسبوعي | FAC | `fac:cohort_schedule:{cohortId}:{isoWeek}` | 6 ساعات | `ScheduleConfirmed/Changed` |
| جدول المحاضر | FAC | `fac:lecturer_schedule:{lecturerId}:{isoWeek}` | 6 ساعات | نفس الأحداث |
| الإعلانات العامة | CHA | `cha:announcements:{scope}:{targetId}` | ساعة | `AnnouncementPublished` |
| قائمة ملفات مستودع المادة | FIL | `fil:course_files:{courseId}:{category}` | 12 ساعة | `FileLinked/Unlinked` |
| النتائج المنشورة | GRD | `grd:published:{semesterId}:{studentId}` | 24 ساعة | `GradesPublished`، `GradeCorrected` |
| بنك الأسئلة (تصفح المحاضر) | EXM | `exm:qbank:{assignmentId}:v{gen}` | ساعة | `QuestionChanged` (يرفع gen) |
| إعدادات الجامعة | SET | `common:settings:{section}` | 24 ساعة | `SettingsUpdated` |
| صلاحيات الإداري الفرعي | AUTH | `auth:perms:{userId}:{permVersion}` | 15 دقيقة | تغيّر `perm_version` يغيّر المفتاح |
| بيانات البرنامج والدفعة | ADM | `common:cohort:{id}`، `common:program:{id}` | 24 ساعة | `CohortUpdated`... |
| حالة معاملة مالية قيد المراجعة | — | **لا يُكاش** | — | — |
| حالة جلسة امتحان حية وإجاباتها | — | **لا يُكاش** | — | — |
| حالة الحضور اللحظية | — | **لا يُكاش** | — | — |
| رصيد الطالب | — | **لا يُكاش** في MVP (VIEW سريع) | — | — |

### 14.3 طبقة الوصول المعزولة

```ts
// src/kernel/cache/cache.module.ts
@Module({})
export class CacheModule {
  static forFeature(namespace: ModuleNamespace): DynamicModule {
    return {
      module: CacheModule,
```ts
      providers: [{
        provide: cacheToken(namespace),
        useFactory: (redis: RedisCacheClient, cls: ClsService, settings: TenantCodeResolver) =>
          new ScopedCache(redis, namespace, () => settings.codeOf(cls.get('tenantId'))),
        inject: [RedisCacheClient, ClsService, TenantCodeResolver],
      }],
      exports: [cacheToken(namespace)],
    };
  }
}

// src/kernel/cache/scoped-cache.ts
export class ScopedCache {
  constructor(private readonly r: RedisCacheClient, private readonly ns: ModuleNamespace,
              private readonly tenant: () => Promise<string>) {}

  private async key(resource: string, id: string) {
    if (!/^[a-z_]+$/.test(resource)) throw new Error('BAD_RESOURCE');
    return `ah:${await this.tenant()}:${this.ns}:${resource}:${id}`;
  }

  async getOrLoad<T>(resource: string, id: string, ttlSec: number, loader: () => Promise<T>): Promise<T> {
    const k = await this.key(resource, id);
    try {
      const hit = await this.r.get(k);
      if (hit !== null) return JSON.parse(hit) as T;
    } catch { return loader(); }                          // سقوط Redis لا يُسقط الطلب
    const v = await loader();
    const jitter = Math.floor(ttlSec * 0.1 * Math.random());   // منع انتهاء جماعي متزامن
    this.r.set(k, JSON.stringify(v), 'EX', ttlSec + jitter).catch(() => undefined);
    return v;
  }

  async invalidate(resource: string, id: string) { await this.r.unlink(await this.key(resource, id)); }
}

// قراءة common: واجهة قراءة فقط تُحقن لأي وحدة
export class CommonCacheReader { /* get(resource,id) فقط — الكتابة/الإبطال للمالك */ }
```

كل وحدة تحقن `@InjectCache('fac')` فقط، وقاعدة `no-direct-redis` في القسم 5.2 تمنع أي وصول آخر. هذا يحقق القاعدة النهائية في وثيقة الكاش: الوحدة تصل إلى كاشها الخاص وتقرأ من `common`، ولا تصل إلى كاش وحدة أخرى.

### 14.4 الإبطال المربوط بالأحداث

```ts
@IdempotentHandler('fac.cacheInvalidator', ['fac.ScheduleConfirmed.v1', 'fac.ScheduleChanged.v1'])
export class FacCacheInvalidator {
  constructor(@InjectCache('fac') private readonly cache: ScopedCache) {}
  async handle(e: OutboxRow) {
    const { cohortId, lecturerId, isoWeeks } = e.payload as SchedulePayload;
    await Promise.all(isoWeeks.flatMap(w => [
      this.cache.invalidate('cohort_schedule', `${cohortId}:${w}`),
      lecturerId && this.cache.invalidate('lecturer_schedule', `${lecturerId}:${w}`),
    ]));
  }
}
```

كل وحدة تملك مستمع إبطال لكاشها فقط، وهي استثناء مسموح لأنها تستمع لأحداثها هي. يتم الإبطال بعد COMMIT عبر الـ outbox، فلا يُعاد ملء الكاش بقيمة قديمة. ولأن التوصيل مرة واحدة على الأقل، تبقى هناك نافذة قصيرة بين COMMIT والإبطال تصل إلى ثانيتين تقريباً، وهذا مقبول لبيانات شبه ثابتة. للمفاتيح التي فيها مجموعات كبيرة (بنك الأسئلة) يُستخدم رفع عدّاد الجيل `gen` بدل `SCAN`، فالمفاتيح القديمة تختفي بـ LRU.

### 14.5 الإعدادات

```conf
# redis-cache.conf
maxmemory 96mb
maxmemory-policy allkeys-lru
save ""
appendonly no

# redis-core.conf
maxmemory 128mb
maxmemory-policy noeviction        # إلزامي لـ BullMQ
appendonly yes
appendfsync everysec
```

المراقبة: نسبة الإصابة (`keyspace_hits / (hits+misses)`) والهدف أعلى من 80% للجداول، و`used_memory` في `redis-core` مع إنذار عند 80%، لأن امتلاءه يوقف الطوابير.

---

## 15. ضبط PostgreSQL وPgBouncer

### 15.1 postgresql.conf

القيم المحسومة في الملخص (`shared_buffers=512MB` و`max_connections=40` و`work_mem=4MB`) ثابتة، وأضفت حولها الباقي:

```conf
# الذاكرة (ميزانية Postgres ~1.2GB)
shared_buffers = 512MB              # [محسوم]
work_mem = 4MB                      # [محسوم] — لكل عملية فرز، لا لكل اتصال
maintenance_work_mem = 128MB        # VACUUM / CREATE INDEX
effective_cache_size = 1536MB       # تقدير لكاش نظام التشغيل؛ لا يحجز ذاكرة
huge_pages = off                    # 4GB لا تستفيد منها
temp_file_limit = 2GB               # يحمي القرص من استعلام شارد

# الاتصالات
max_connections = 40                # [محسوم] — PgBouncer يجمّع فوقها
superuser_reserved_connections = 3
idle_in_transaction_session_timeout = 30s
statement_timeout = 15s             # يُرفع لكل جلسة worker عند الحاجة (archive: 0)
lock_timeout = 5s

# التخزين SSD
random_page_cost = 1.1
effective_io_concurrency = 200

# WAL والنسخ (مطلوب لـ PITR)
wal_level = replica
wal_compression = zstd
max_wal_size = 2GB
min_wal_size = 256MB
checkpoint_completion_target = 0.9
archive_mode = on
archive_command = 'pgbackrest --stanza=ah archive-push %p'

# المعالجات (2 vCPU)
max_worker_processes = 4
max_parallel_workers = 2
max_parallel_workers_per_gather = 1

# Autovacuum أكثر عدوانية للجداول الساخنة
autovacuum_naptime = 30s
autovacuum_vacuum_scale_factor = 0.05
autovacuum_analyze_scale_factor = 0.02

# الرصد
shared_preload_libraries = 'pg_stat_statements'
log_min_duration_statement = 300ms
log_lock_waits = on
log_temp_files = 0
```

وللجداول عالية الحركة: `ALTER TABLE krn.events_outbox SET (autovacuum_vacuum_scale_factor = 0.01, fillfactor = 90);` ونفس الشيء لـ `submission_answers` و`idempotency_keys`.

### 15.2 pgbouncer.ini

```ini
[databases]
ah = host=postgres port=5432 dbname=ah

[pgbouncer]
pool_mode = transaction
max_client_conn = 400
default_pool_size = 20
min_pool_size = 4
reserve_pool_size = 5
reserve_pool_timeout = 3
server_idle_timeout = 60
max_prepared_statements = 100      # PgBouncer ≥1.21 يدعم prepared statements في transaction mode
auth_type = scram-sha-256
ignore_startup_parameters = extra_float_digits,options
```

الحساب: مجموعة PgBouncer فيها 20 اتصالاً، والاحتياطي 5، واتصال LISTEN المباشر واحد، والـ migrations والنسخ الاحتياطي 3، والمحجوز للمشرف 3. المجموع 32، أي تحت سقف 40 بهامش. قاعدة الكود: لا `SET` بدون `LOCAL`، ولا جداول مؤقتة خارج المعاملة، ولا advisory locks على مستوى الجلسة (يُستخدم `pg_advisory_xact_lock` فقط).

### 15.3 مراقبة الاستعلامات

أسبوعياً: أبطأ 10 استعلامات من `pg_stat_statements` حسب `total_exec_time`، والجداول ذات `seq_scan` العالي، ونسبة `dead tuples`. وقبل إضافة أي فهرس جديد يُشغَّل `EXPLAIN (ANALYZE, BUFFERS)`.

---

## 16. تخزين الملفات

تدفق الرفع: يطلب العميل `POST /files/upload-intent {mime, size, purpose}`. يتحقق الخادم من النوع والحجم حسب الغرض، ويُنشئ صف `krn.files` بحالة PENDING، ويعيد Presigned PUT URL صالحاً 10 دقائق. يرفع العميل مباشرة إلى التخزين عبر nginx (`/files/`)، فلا تمر الملفات عبر ذاكرة NestJS. ثم يرسل `POST /files/:id/complete`. هنا يتحقق الخادم بـ `HeadObject` من الحجم، ويقرأ أول البايتات للتحقق من النوع الحقيقي (magic bytes)، فيصبح الملف READY. التنزيل يكون بـ Presigned GET صالحاً 5 دقائق، بعد فحص الصلاحية في الخادم. وثائق الطالب (`PII`) يُسجَّل كل وصول لها في التدقيق (FR-ADM-039).

الحاويات (buckets): `ah-docs` للوثائق الشخصية والإشعارات المالية، و`ah-content` لملفات المواد، و`ah-archives` للأرشيف، و`ah-generated` لملفات PDF وExcel المولّدة (تُحذف بعد 30 يوماً، وإعادة توليدها ممكنة). حدود الحجم المقترحة: الصور 5MB (يضغطها العميل قبل الرفع بسبب الشبكة)، وPDF حتى 25MB، والصوت حتى 50MB. الفيديو مرفوض حسب SC-OUT-06.

---

## 17. تصميم الـ API

الأساس `/api/v1`، والمسارات بأسماء الوحدات (`/api/v1/pay/transactions`). العقد موثق بـ OpenAPI مولّد من NestJS Swagger، ومنه يُولَّد عميل Dart للتطبيق وعميل TypeScript للويب، فلا يُكتب العقد يدوياً مرتين.

الأخطاء بصيغة RFC 9457 (Problem Details):

```json
{ "type": "https://errors.academichub.sd/precondition-failed",
  "title": "لا يمكن جمع النتائج", "status": 412, "code": "MISSING_COMPONENTS",
  "details": [{ "course": "علم التشريح 2", "component": "MIDTERM" }], "traceId": "01J..." }
```

الترقيم بالمؤشر (`?cursor=&limit=50`، والحد الأقصى 100) لأن معرفات uuidv7 مرتبة. تحديد المعدل في nginx لكل IP (عام)، وفي `redis-core` لكل مستخدم على المسارات الحساسة (الدخول: 10 في الدقيقة، ورفع الإشعارات المالية: 20 في الساعة). الاستجابات مضغوطة بـ gzip/brotli في nginx، وحقول القوائم مختصرة لتوفير بيانات الطالب.

---

## 18. الأمان والخصوصية

| المجال | الإجراء |
|---|---|
| النقل | TLS 1.2 فما فوق عبر Let's Encrypt (certbot)، وHSTS، والمنافذ المفتوحة 443 و80 (لإعادة التوجيه) و22 بمفتاح فقط |
| الأسرار | ملف `.env` بصلاحيات 600 خارج المستودع، وKEK للأرشيف في ملف منفصل، ونسخة احتياطية من الأسرار مشفرة بـ age وتُحفظ خارج الخادم داخل السودان |
| كلمات السر | argon2id (للمراقب فقط، إذ لا كلمات سر لغيره) |
| التشفير أثناء التخزين | تشفير قرص الـ VPS إن دعمه المزود، والأرشيف بـ AES-256، والنسخ الاحتياطية مشفرة في pgBackRest |
| العزل | RLS والمفاتيح الأجنبية المركبة وبادئة الكاش والغرف، مع اختبار تكامل يحاول الوصول عبر الجامعات لكل وحدة |
| الإدخال | `ValidationPipe` بـ `whitelist` و`forbidNonWhitelisted`، وZod للـ jsonb |
| الأجهزة والجلسات | القسم 7 |
| الحاويات | صور بمستخدم غير root، و`read_only: true` حيث أمكن، والتحديثات الأمنية تلقائية (`unattended-upgrades`)، وfail2ban على SSH |
| التبعيات | `pnpm audit` وRenovate في CI |
| الذكاء الاصطناعي | لا PII في الـ prompt، والإرسال للمزود الخارجي معلّق على قرار الاستضافة (القسم 23) |

---

## 19. بنية النشر

### 19.1 docker-compose.yml (مختصر)

```yaml
x-app: &app
  image: academichub/app:${TAG}
  env_file: .env
  restart: unless-stopped
  depends_on: [pgbouncer, redis-core, redis-cache]

services:
  nginx:
    image: nginx:1.27-alpine
    ports: ["80:80", "443:443"]
    volumes: [./nginx:/etc/nginx/conf.d:ro, /etc/letsencrypt:/etc/letsencrypt:ro]
    mem_limit: 64m
  api:
    <<: *app
    command: ["node", "--max-old-space-size=448", "dist/main.api.js"]
    mem_limit: 640m
  worker:
    <<: *app
    command: ["node", "--max-old-space-size=320", "dist/main.worker.js"]
    mem_limit: 448m
  postgres:
    image: postgres:18-alpine
    volumes: [pgdata:/var/lib/postgresql/data, ./pg/postgresql.conf:/etc/postgresql/postgresql.conf:ro]
    command: ["postgres", "-c", "config_file=/etc/postgresql/postgresql.conf"]
    shm_size: 256m
    mem_limit: 1280m
  pgbouncer:
    image: edoburu/pgbouncer:latest
    volumes: [./pgbouncer:/etc/pgbouncer:ro]
    mem_limit: 32m
  redis-core:
    image: redis:7.4-alpine
    command: ["redis-server", "/usr/local/etc/redis/redis.conf"]
    volumes: [./redis/core.conf:/usr/local/etc/redis/redis.conf:ro, rediscore:/data]
    mem_limit: 160m
  redis-cache:
    image: redis:7.4-alpine
    command: ["redis-server", "/usr/local/etc/redis/redis.conf"]
    volumes: [./redis/cache.conf:/usr/local/etc/redis/redis.conf:ro]
    mem_limit: 112m
  garage:
    image: dxflrs/garage:v2.1.0
    volumes: [./garage/garage.toml:/etc/garage.toml:ro, garagemeta:/var/lib/garage/meta, garagedata:/var/lib/garage/data]
    mem_limit: 128m

volumes: { pgdata: {}, rediscore: {}, garagemeta: {}, garagedata: {} }
```

ملاحظة: أرقام الإصدارات في الصور أمثلة، ويجب تثبيت أحدث إصدار مستقر بالضبط (digest) وقت النشر. تجنّب `latest` في الإنتاج.

### 19.2 ميزانية الذاكرة المعدّلة

| المكوّن | الحد | الملاحظة |
|---|---|---|
| Postgres | 1280MB | 512 shared_buffers والباقي للعمليات |
| API | 640MB | heap 448MB |
| Worker | 448MB | heap 320MB، والأرشيف بالتدفق |
| redis-core وredis-cache | 272MB | بدل 200 إلى 350 |
| Garage | 128MB | بدل نحو 300 لـ MinIO (ADR‑N2) |
| nginx وPgBouncer | 96MB | |
| أدوات الرصد | 120MB | القسم 20 |
| النظام وكاش الملفات | نحو 1100MB | يستفيد منه Postgres عبر `effective_cache_size` |

تغيير MinIO إلى Garage وفّر نحو 170MB، وهذا يعطي هامشاً أوسع مما في الملخص، لكنه يبقى ضيقاً. يُضاف ملف swap بحجم 2GB مع `vm.swappiness=10` كشبكة أمان ضد قاتل الذاكرة (OOM)، لا كذاكرة عمل.

### 19.3 خط النشر

```
git push main ─▶ CI (GitHub Actions أو Gitea ذاتي):
   lint + typecheck + dependency-cruiser + fsm:sync --check + unit + integration (testcontainers)
   ─▶ build image (multi-stage, node:22-alpine) ─▶ push لسجل خاص
VPS: ./deploy.sh TAG
   1. docker compose pull
   2. docker compose run --rm api node dist/migrate.js   # اتصال مباشر، دور ah_migrator
   3. docker compose up -d --no-deps worker api
   4. فحص /health/ready ؛ فشل ─▶ إعادة TAG السابق
```

الـ migrations تتبع نمط expand ثم contract: الإضافة أولاً متوافقة مع الكود القديم، والحذف بعد إصدار لاحق. وممنوع نشر أي migration أثناء نافذة امتحانات حية (فحص آلي في `deploy.sh` يستعلم عن امتحانات LIVE أو READY خلال الساعتين القادمتين).

إذا كانت خدمات CI السحابية تتعارض مع NFR-HOST-001 لأنها تلمس بيانات، فالجواب لا: الـ CI يتعامل مع الكود وبيانات اختبار وهمية فقط. ومع ذلك يُوثَّق هذا صراحة في BRD.

---

## 20. الرصد والتشغيل

هذه تغطية للفجوة الخامسة في BRD 3.3 (غياب لوحة مراقبة للمشغّل)، بأقل تكلفة ممكنة في الذاكرة.

| الطبقة | الأداة | السبب |
|---|---|---|
| السجلات | pino بصيغة JSON مع `traceId` و`tenantId`، وتدوير بـ Docker `json-file` بحد 50MB×3 | خفيف، ولا يحتاج ELK |
| المقاييس | `/metrics` بـ prom-client، يُجمع بـ Prometheus بإعداد الاحتفاظ 15 يوماً، مع node_exporter وpostgres_exporter وredis_exporter | نحو 120MB إجمالاً |
| العرض والإنذار | Grafana على جهاز المطور عبر نفق SSH، أو Uptime Kuma خارجي داخل السودان | لا يستهلك ذاكرة الخادم |
| الصحة | `/health/live` (العملية حية)، و`/health/ready` (قاعدة البيانات وRedis والتخزين) | |
| الأخطاء | GlitchTip ذاتي الاستضافة لاحقاً، وفي MVP جدول أخطاء وإشعار بريدي | Sentry SaaS يُرسل بيانات للخارج |

الإنذارات الأساسية: الذاكرة المتاحة أقل من 300MB، والقرص أعلى من 80%، وعمر أقدم حدث غير منشور في outbox أكثر من 60 ثانية، وطوابير BullMQ الفاشلة أكثر من 10، ونسبة أخطاء 5xx أعلى من 1%، وزمن p95 للـ API أعلى من 800ms، وفشل آخر نسخة احتياطية. وأهم مؤشر في نافذة الامتحان: وجود امتحان LIVE تجاوز `ends_at` بأكثر من دقيقتين.

---

## 21. النسخ الاحتياطي والتعافي

| البيانات | الأداة | التكرار | الاحتفاظ | الوجهة |
|---|---|---|---|---|
| Postgres | pgBackRest: نسخة كاملة أسبوعية، وتفاضلية يومية، وأرشفة WAL مستمرة | مستمر | 4 أسابيع، وPITR خلال 14 يوماً | موقع ثانٍ داخل السودان، بتشفير `repo1-cipher-type=aes-256-cbc` |
| pg_dump منطقي | `pg_dump -Fc` | يومي | 7 نسخ | نفس الموقع (يسهّل استعادة جامعة واحدة) |
| التخزين | `rclone sync` بتشفير crypt | أسبوعي كما في الملخص، وأقترح يومياً لـ `ah-docs` لأنها وثائق لا يمكن إعادة إنشائها | 4 أسابيع | نفس الموقع |
| الإعدادات والأسرار | git للإعدادات، وage للأسرار | عند التغيير | — | — |

تفاوت مهم: الملخص يقول pg_dump يومي مع WAL، والصحيح تقنياً أن WAL يحتاج نسخة فيزيائية أساسية (pg_basebackup أو pgBackRest) لا pg_dump. لذلك اعتمدت pgBackRest للاستعادة الزمنية، وأبقيت pg_dump كنسخة منطقية إضافية.

الأهداف: RPO أقل من 5 دقائق لقاعدة البيانات (عبر WAL)، وRTO نحو 4 ساعات (إعداد خادم جديد واستعادة)، وهذا مقبول خارج نوافذ الامتحانات فقط. **اختبار الاستعادة شهرياً على خادم مؤقت إلزامي**، لأن النسخة التي لم تُختبر لا يمكن الاعتماد عليها.

---

## 22. استراتيجية الاختبار لمطور منفرد

المبدأ: ركّز الاختبارات حيث يكون الخطأ مكلفاً وصامتاً، أي المال والامتحانات والعزل والحالات، لا حيث يكون ظاهراً وسهل الإصلاح كالواجهات البسيطة.

| المستوى | ماذا يُختبر | الأدوات | الحجم التقريبي |
|---|---|---|---|
| وحدة نقي (Unit) | تعريفات آلات الحالات، والـ guards بمدخلات وهمية، وحساب الدرجات والتقديرات، ونسبة الغش، ودمج الحضور، والرصيد | Vitest | نحو 60% من العدد، وتعمل في ثوانٍ |
| تكامل (Integration) | مسار كامل مع Postgres وRedis حقيقيين: RLS، والـ triggers، وقيود EXCLUDE، وOutbox حتى المستمع، وIdempotency | Vitest + Testcontainers + Supertest | نحو 35% |
| عقد (Contract) | توافق OpenAPI المولّد مع الإصدار السابق | oasdiff في CI | آلي |
| شامل (E2E) | 3 سيناريوهات فقط: فصل كامل من IDLE إلى ARCHIVED، وامتحان أونلاين مع انقطاع، ودفعة مالية حتى الإيصال | نفس أدوات التكامل عبر HTTP | نحو 5% |
| حمل | 300 طالب يبدؤون امتحاناً في الدقيقة نفسها ويحفظون كل 15 ثانية | k6 على نسخة مطابقة للإنتاج | قبل التجربة الأولى، ثم قبل كل موسم امتحانات |

اختبارات إلزامية لا يُدمج أي كود بدونها:

```ts
// test/integration/tenant-isolation.spec.ts
describe.each(ALL_TENANT_TABLES)('RLS on %s', (table) => {
  it('tenant B cannot read rows of tenant A', async () => {
    await seedRow(table, TENANT_A);
    const rows = await asTenant(TENANT_B, tx => tx.execute(sql`SELECT * FROM ${sql.raw(table)}`));
    expect(rows.rowCount).toBe(0);
  });
  it('fails closed without tenant context', async () => {
    const rows = await db.execute(sql`SELECT * FROM ${sql.raw(table)}`);   // بلا SET LOCAL
    expect(rows.rowCount).toBe(0);
  });
});
// ALL_TENANT_TABLES يُستخرج آلياً من information_schema: أي جدول جديد بلا RLS يفشل الاختبار

// test/integration/fsm-bypass.spec.ts
it('direct state UPDATE is rejected by trigger', async () => {
  await expect(asTenant(T, tx => tx.execute(sql`UPDATE pay.transactions SET state='ACCEPTED' WHERE id=${id}`)))
    .rejects.toThrow(/FSM_BYPASS/);
});

// test/integration/idempotency.spec.ts
it('same key + same body → single upload, replayed response', async () => {
  const [a, b] = await Promise.all([postUpload(key, body), postUpload(key, body)]);
  expect([a.status, b.status].sort()).toEqual([201, 409]);    // أو 201/201 مع Replayed
  expect(await countUploads(sessionId)).toBe(1);
});
it('answer with older clientSeq never overwrites newer', async () => { /* ... */ });
it('auto-submit fires even if delayed job is lost (sweeper)', async () => { /* ... */ });
```

نصائح عملية: حاوية Postgres واحدة لكل تشغيل اختبارات، وكل اختبار داخل معاملة تُلغى في النهاية، أو قاعدة بيانات قالب تُنسخ (`CREATE DATABASE ... TEMPLATE`) للسرعة. وبيانات الاختبار تُبنى بمصانع (factories) لا بملفات ثابتة. مقياس التغطية المطلوب ليس رقماً عاماً، بل 100% من الانتقالات المعرّفة في الآلات الخمس، وكل مسار من مسارات الـ Idempotency الثلاثة.

---

## 23. المخاطر والمسائل المفتوحة

| الرمز | الخطر أو المسألة | الأثر | المعالجة أو القرار المطلوب |
|---|---|---|---|
| R-01 | خادم واحد هو نقطة فشل واحدة، ويتعارض مع هدف 99.9% في نوافذ الامتحانات (RSK-03) | حرج | **غير محلول بهذا التصميم.** معلّق على OI-05. تخفيف مؤقت: تجميد النشر في النوافذ، وخادم احتياطي بارد مع استعادة مُختبرة، ونافذة سماح offline. المسار المستقبلي: خادم ثانٍ لـ Postgres كنسخة متماثلة (streaming replica)، ثم نسختا api خلف nginx، والكود جاهز لذلك (Redis adapter وعدم وجود حالة في الذاكرة) |
| R-02 | البنية لا تحل التوافر، بل تبني فوق القيد | عالٍ | يجب أن يُذكر صراحة لمالك المنتج والجامعة التجريبية |
| R-03 | تناقض FR-SET-011 مع القرار 25 (حذف الإشعار SA-05) | متوسط | قرار مطلوب. توصيتي التقنية: إبقاء الزر وتحويله إلى تذكرة دعم فئة "تعديل بيانات" في CHA، فتظهر في قائمة الإداري دون إشعار مستقل. وفي MVP، لأن CHA مؤجلة، يُخفى الزر مؤقتاً |
| R-04 | MinIO في وضع الصيانة (ADR‑N2) | عالٍ (أمني) | تصديق Garage، وتسجيل تصحيح R2 في BRD |
| R-05 | تصحيح الذكاء الاصطناعي يحتاج مزوداً، والمزودون الكبار خارج السودان، وهذا قد يتعارض مع NFR-HOST-001 حتى لو أُرسلت إجابات بلا هوية | عالٍ (v1.1) | قرار مالك المنتج: هل إجابة امتحان مجهولة الهوية "بيانات شخصية"؟ البدائل: نموذج محلي (يحتاج خادماً بـ GPU، غير ممكن على 4GB)، أو موافقة صريحة، أو إبقاء التصحيح يدوياً. **هذا مانع لـ v1.1 حتى يُحسم** |
| R-06 | FCM يمر عبر Google | منخفض | الإشعار المدفوع يحمل `{type, id}` فقط بلا محتوى، ويجلب التطبيق المحتوى من الخادم |
| R-07 | ضيق الذاكرة | متوسط | ميزانية صريحة وإنذارات من الأسبوع الأول، والترقية إلى 8GB هي أول خطوة توسعة |
| R-08 | أجزاء من BRD لم تُقرأ (القسم 0.1) | متوسط | مطابقة كل [افتراض‑SD] قبل migration وحدته |
| R-09 | ربط الجهاز في MVP (installation_id) يمكن تجاوزه على جهاز مخترق (rooted) | متوسط | v1.1: مفاتيح Keystore وPlay Integrity API |
| R-10 | تصميم RLS خاطئ يسرّب البيانات | حرج | اختبار العزل الآلي الشامل (القسم 22) |
| R-11 | البريد نفسه في أكثر من جامعة (6.4) | منخفض | تأكيد في BRD |

---

## 24. خطة التنفيذ وتسلسل MVP

الترتيب يتبع الاعتمادية، وأول أسبوعين للبنية فقط. السبب أن النواة (TenantTx وFSM وOutbox وIdempotency والكاش واختبار العزل) هي ما يجعل كل الوحدات اللاحقة أسرع وأكثر أماناً.

| المرحلة | المحتوى | تقدير (دوام جزئي) |
|---|---|---|
| 0. الأساس | المستودع، Docker Compose، CI، dependency-cruiser، KRN كاملة، اختبار العزل، الرصد الأساسي | 3 أسابيع |
| 1. AUTH | Google، الأجهزة، الصلاحيات، التدقيق، المراقب | 2.5 |
| 2. ADM (+ OWN الأدنى: إنشاء جامعة واحدة بسكربت) | البرامج، الدفعات، الطلاب، الوثائق، آلة الفصل | 3.5 |
| 3. FAC (الأساسي: منشآت، حجوزات، قيود EXCLUDE، بلا اقتراح آلي) | لازم لأن الحضور والامتحان يحتاجان أحداثاً بزمن ومكان | 2 |
| 4. PAY | المعاملات، آلة المراجعة، الإيصالات، الرصيد | 3 |
| 5. ATT | QR أولاً ثم البلوتوث، مع Idempotency | 2.5 |
| 6. GRD | الموازين، أعمال السنة، النتائج | 2 |
| 7. EXM | بنك الأسئلة، آلة الامتحان، الحفظ offline، التسليم التلقائي، الملحق | 5 |
| 8. PRC الأساسي | الأحداث، النسبة، قائمة المراجعة، آلة الحالة | 1.5 |
| 9. FIL وNOT وSET الأساسية | المستودع، صندوق النتائج، مركز الإشعارات وFCM، الإعدادات | 2.5 |
| 10. الأرشيف وE2E والحمل وتجهيز التجربة | | 2 |
| **المجموع** | | **نحو 29.5 أسبوعاً** (ضمن تقدير الملخص 24 إلى 30) |

ملاحظة: ملخص التسليم يضع FAC صراحة داخل حدود MVP في معيار الاختيار ("المنشآت والجداول")، لكنه لم يذكرها في قائمة "داخل MVP"، وذكر في v1.1 "الكاملة (اقتراح آلي + كشف تعارض)" دون اسم الوحدة. فسّرت ذلك بأن FAC الأساسية داخل MVP، والاقتراح الآلي في v1.1. أما كشف التعارض فأبقيته في MVP لأن قيود EXCLUDE تقدمه تقريباً بلا تكلفة. يحتاج هذا تأكيداً.

**v1.1:** CHT (بعد حسم R-05)، والاقتراح الآلي في FAC، وCHA، وDSH الكاملة، وبوابة المراقب الكاملة، وربط الجهاز المعزز. **التوسع اللاحق:** لوحة المالك الكاملة، والاستيراد الجماعي، والتوافر العالي (R-01).

بعد إنجاز المرحلتين 1 و2 فعلياً، يُعاد التقدير بقسمة الزمن الفعلي على المقدّر، وتُضرب باقي المراحل في هذه النسبة.

---

## 25. ملحق: قائمة القرارات المطلوب تسجيلها في BRD

1. تصحيح تخزين الملفات من R2 إلى تخزين ذاتي الاستضافة داخل السودان، والمحرك Garage (ADR‑N2).
2. حسم تناقض FR-SET-011 مع القرار 25 (R-03).
3. سياسة إرسال الإجابات لمزود ذكاء اصطناعي خارجي (R-05)، وهي مانع لـ v1.1.
4. نافذة السماح للإجابات المتأخرة offline (الافتراضي المقترح 10 دقائق، قابل للضبط في إعدادات الامتحانات).
5. سلوك البريد المكرر عبر الجامعات (6.4).
6. موقع FAC في MVP (القسم 24).
7. توثيق أن CI لا يلمس بيانات حقيقية، وأن FCM لا يحمل محتوى، في سياق NFR-HOST-001.

---

تنبيه أخير عن حدود هذه الوثيقة: لم أتمكن من قراءة BRD.md كاملاً (القسم 0.1)، فكل ما هو موسوم بـ [افتراض‑SD] يحتاج مطابقة قبل التنفيذ. وأهم قرارين يحتاجان رأيك الآن قبل الكتابة: فصل Redis إلى نسختين (ADR‑N1)، وهو إصلاح لتعارض حقيقي مع متطلبات BullMQ، واستبدال MinIO (ADR‑N2) لأن المشروع توقف عن التطوير الفعلي.