# proactive-gate

[English](README.md) | Türkçe

Proaktif bir yapay zekâ ajanının kullanıcıya şu an ulaşıp ulaşamayacağına karar verir ve
neden ulaşamadığını kaydeder.

Proaktif bir asistanın iki yarısı vardır. Üreten yarı neyin söylenmeye değer olduğuna karar
verir. Bastıran yarı ise onu şimdi mi, sonra mı, hiç mi söyleyeceğine karar verir. Proaktif
yapay zekâ üzerine yazılan hemen her şey ilk yarı hakkındadır. Bu paket ikinci yarıdır: tek
kapı, sıralı bir kontrol listesi ve her ret için bir gerekçe.

```
npm install proactive-gate
```

```ts
import { createGate, defaultChecks, RedisStore } from "proactive-gate";

const gate = createGate({
  store: new RedisStore(redis),                  // MemoryStore() for one instance
  checks: defaultChecks({ dailyLimit: 3, quietHoursFloor: "high" }),
  onDecision: (d) => log.info("gate", d),        // every decision, allowed or not
});

const decision = await gate.evaluate({ user, candidate });
if (decision.allowed && (await gate.commit(decision, { user, candidate }))) {
  await send(decision.surfaces, candidate.payload);
}
```

Sıfır bağımlılık. TypeScript. Node 20 ya da üstü. Framework'ten bağımsız: kapı, "model bir
şey üretti" ile "kullanıcının telefonu titredi" arasında durur; hangi model ya da framework
üretmiş olursa olsun. Örnekler: [`examples/vercel-ai-sdk.ts`](examples/vercel-ai-sdk.ts),
[`examples/mastra.ts`](examples/mastra.ts) ve yeniden oynatılabilir bir politika olarak
[`examples/policy.json`](examples/policy.json). Dokümantasyon ve tarayıcıda oyun alanı:
[bubblegunn.github.io/proactive-gate](https://bubblegunn.github.io/proactive-gate/). Python:
[`python/`](python/README.md).

## Bir karar neye benzer

```ts
{
  allowed: false,
  userId: "ayse",
  candidateId: "a1",
  rejectedBy: "quietHours",
  reason: "quiet hours 22:00 to 08:00 Europe/Istanbul; priority normal is below the floor (high)",
  surfaces: [],
  trace: [
    { id: "killSwitch", outcome: "pass", ms: 0.02 },
    { id: "consent",    outcome: "pass", ms: 0.01 },
    { id: "enabled",    outcome: "pass", ms: 0.01 },
    { id: "mode",       outcome: "pass", ms: 0.01 },
    { id: "snooze",     outcome: "pass", ms: 0.02 },
    { id: "mute",       outcome: "pass", ms: 0.01 },
    { id: "intensity",  outcome: "pass", ms: 0.02 },
    { id: "quietHours", outcome: "reject", reason: "quiet hours 22:00 to 08:00 …", ms: 0.09 }
  ],
  evaluatedAt: 2026-09-04T03:00:00.000Z
}
```

<p align="center"><img src="assets/trace.png" width="900" alt="Gerçek bir karar izi: sekiz kontrol çalıştı, sessiz saatler reddetti, her biri gerekçesi ve maliyetiyle"></p>

Tek kapı ve kayıtlı bir gerekçe ile "kullanıcıya bu neden söylenmedi" sorusunun bir cevabı
olur. Kontroller bir boru hattına dağılmışken dürüst cevap "bir yerde bir şey false döndü"
olurdu.

## Kontroller, varsayılanın çalıştırdığı sırayla

| # | kontrol | ne zaman reddeder | not |
|---|---|---|---|
| 1 | `killSwitch(isOn)` | bayrağınız açıksa | üretim acil durdurma; her üreticiyi aynı anda susturur |
| 2 | `consent()` | `user.consent` false ise | her şeyden önce gelir, yoksa hiç rıza vermemiş biri için tercih değerlendirmiş olursunuz |
| 3 | `enabled()` | `user.proactiveEnabled === false` ise | profil başına anahtar |
| 4 | `mode({ allow })` | `user.mode` listede değilse | örneğin yalnızca `"normal"`, asla `"focus"` |
| 5 | `snooze()` | `user.snoozedUntil` gelecekteyse | genel duraklatma |
| 6 | `mute()` | `candidate.type`, `user.mutedTypes` içindeyse | tür bazlı susturma |
| 7 | `intensity()` | öncelik, kullanıcının yoğunluk tabanının altındaysa | low yalnızca high duyar, normal normal ve üstünü, high her şeyi |
| 8 | `quietHours({ priorityFloor })` | kullanıcının yerel sessiz penceresi içindeyse | IANA saat dilimi, pencere gece yarısını geçebilir, taban ve üstünde atlanır |
| 9 | `trustRamp({ days, minPriority })` | kullanıcı `days` günden yeniyse ve öncelik tabanın altındaysa | sistem, kullanıcı en az bağışlayıcıyken en az kalibredir |
| 10 | `dismissalCooldown({ dismissals, withinDays, silenceDays })` | kullanıcı o türü pencere içinde `dismissals` kez reddettiyse | `gate.record(user, candidate, "dismissed")` ile beslenir; her yeni ret sessizliği yeniden başlatır |
| 11 | `adaptiveTiming({ nextGoodMoment, surfacesFor })` | asla | reddetmez: `deliverAt` değerini taşır ya da yüzeyleri daraltır; `nonRejecting` işaretli bir kontrol istese de reddedemez |
| 12 | `dailyBudget({ limit, bypassPriority })` | kullanıcının yerel gün sayacı sınırdaysa | `evaluate` okur, `commit` atomik artırır ve yine de reddedebilir |

Sıra bir tasarım kararıdır ve görünür olmalıdır. Rıza her şeyden önce gelmelidir. Sessiz
saatler bütçeden önce gelmelidir, yoksa reddedilen bir aday hiç yapmadığı bir teslimi
tüketir. İstediğiniz gibi yeniden sıralayın; iz ne yaptığınızı gösterecektir.

```ts
import { createGate, checks } from "proactive-gate";

const gate = createGate({
  checks: [
    checks.consent(),
    checks.quietHours({ priorityFloor: "high" }),
    checks.dailyBudget({ limit: 3, bypassPriority: "critical" }),
    myOwnCheck, // { id, run(ctx) => pass | reject | adjust | skip }
  ],
});
```

### Kendi kontrolünüzü yazmak

Bir kontrol, `id` ve `run` fonksiyonu olan bir nesnedir. Kullanıcıyı, adayı, saati, çözülmüş
önceliği, depoyu ve hâlâ masada olan yüzeyleri alır; `pass`, gerekçeli `reject`, `adjust` ya
da `skip` döndürür. İzde yerleşik kontroller gibi görünür.

```ts
const weekendFloor = {
  id: "weekendFloor",
  run: ({ now, priority }) => {
    const day = now.getUTCDay();
    if ((day === 0 || day === 6) && priority !== "high" && priority !== "critical") {
      return { kind: "reject", reason: "weekend: only high priority" };
    }
    return { kind: "pass" };
  },
};
const gate = createGate({ checks: [checks.consent(), weekendFloor, checks.dailyBudget({ limit: 5 })] });
```

Bir kontrol yalnızca zamanlamayı taşıyabiliyor ya da yüzeyleri daraltabiliyorsa
`nonRejecting: true` işaretleyin; kapı ondan gelen bir reddi yok sayar ve bunu izde söyler,
böylece bir zamanlama modelindeki hata bir kullanıcıyı susturamaz.

## Politika bir veridir

Aynı kontroller bir JSON belgesi olarak da yazılabilir; ürün ekibi kuralları dağıtım yapmadan
değiştirir ve aynı dosya TypeScript'te, Python'da, CLI'da ve
[oyun alanında](https://bubblegunn.github.io/proactive-gate/playground/) çalışır:

```json
{
  "specVersion": "1.0.0",
  "checks": [
    { "id": "consent" },
    { "id": "snooze", "defer": true },
    { "id": "quietHours", "priorityFloor": "high" },
    { "preset": "usTcpa" },
    { "id": "utilityFloor", "costFalseAlarm": 1, "costMissedHelp": 2, "shadow": true },
    { "id": "dailyBudget", "limit": 3, "bypassPriority": "critical", "nearLimit": 0.67 }
  ]
}
```

```ts
const gate = createGate({ policy: JSON.parse(await readFile("policy.json", "utf8")), store });
```

Her girdi bir kontrol `id`'si ya da bir `preset` ve o kontrolün seçeneklerini taşır. Bilinmeyen
bir id hata fırlatır ve bilinenleri sayar. Şema
[`spec/schema/policy.schema.json`](spec/schema/policy.schema.json) dosyasındadır;
`examples/policy.js`, fonksiyon gerektiren kontroller için kaçış yolu olarak durur.

## Erteleme, gölge modu, sınıra yakınlık notları ve kancalar

Bir kontrol reddetmek yerine `defer` diyebilir: karar `allowed: false`, `deferredBy` ve
`retryAt` taşır, çağıran ne zaman tekrar deneyeceğini bilir. `snooze({ defer: true })` yerleşik
örnektir.

`shadow: true` işaretli bir kontrol çalışır ve izde gerçek sonucuyla görünür, ama mesajı
durduramaz; id'si `decision.shadowed` listesine düşer. Yeni bir kuralı bir hafta gölgede
çalıştırın, kaç kez ateşleyeceğini sayın, sonra açın.

Bütçeler eşiğe (varsayılan yüzde 80) ulaşan geçişte `nearLimit: { used, limit }` bildirir;
`decision.nearLimit` altında listelenir, böylece bir pano kimin susmak üzere olduğunu gösterir.

`hooks: { before, after, error, finally }` her kontrolü milisaniye maliyetiyle gözler; hata
fırlatan bir kanca `error` kancasına yönlendirilir ve kararı asla değiştirmez.
`examples/otel.ts` bunları kontrol başına bir span'e çevirir. Her kararın bir `id`'si vardır ve
`commit` bu id üzerinde tekrarlanabilir: zaman aşımından sonraki bir yeniden deneme ikinci
bir birim tüketmez.

## İsteğe bağlı, kendi modelinizin beslediği kontroller

İkisi de kapalı gelir; adayın üzerine çağıranın koyduğu sayıları okurlar.

- `utilityFloor({ costFalseAlarm, costMissedHelp })` yalnızca `candidate.pAccept` değeri
  `tau = cFA / (cFA + pNeed * cFN)` eşiğini geçtiğinde konuşur (`pNeed` varsayılanı 1);
  `pAccept` yoksa atlar. Bu, Horvitz'in beklenen fayda kuralı ve PRISM eşiğidir.
- `boundedDeferral({ lambda, interruptCost, staleness, boundSeconds })` asla reddetmez.
  `candidate.busy` doğruysa `deliverAt` değerini `now + t*` yapar;
  `t* = min(bound, lambda * interruptCost / (2 * staleness))`, varsayılanlar 116 saniye verir.

## Hazır paketler: platform kotaları ve yasal sınırlar, kaynaklarıyla

```ts
import { presets } from "proactive-gate/presets";
const gate = createGate({ checks: [checks.consent(), ...presets.kakaoBrandMessage()] });
```

| paket | ne kodlar |
|---|---|
| `lineMessagingApi({ plan })` | LINE planına göre aylık push bütçesi: 200, 5.000 ya da 30.000 |
| `wechatSubscriptionMessage` | abonelik onayı başına bir mesaj |
| `wechatCustomerService` | kullanıcının son mesajından sonraki 48 saat içinde en çok 5 |
| `wechatTemplateMessage` | yalnızca kullanıcı eyleminden sonra, günde 3 şablon |
| `wecomAppMessage` | üye başına dakikada 30 ve saatte 1.000 |
| `kakaoAlimtalk` | yalnızca rıza; AlimTalk'ta saat kuralı yok |
| `kakaoBrandMessage` | reklam rızası, 08:00 ile 20:50 Asia/Seoul |
| `krNetworkAct50` | reklam rızası, ayrıca 21:00 ile 08:00 yerel saat için gece rızası |
| `jpAntiSpamLaw` | opt-in |
| `cnMinorMode` | reşit olmayanlar için: 06:00 ile 22:00 Asia/Shanghai ve günde bir |
| `usTcpa` | kullanıcının yerel saatiyle 08:00 ile 21:00 (47 CFR 64.1200) |
| `euEprivacy` | pazarlama rızası, mevcut müşteriler için yumuşak opt-in |
| `telegramBot` | sohbet başına saniyede 1 ve dakikada 20 |
| `slackApp` | kanal başına saniyede 1 |

Her paket `sources` (sayıların geldiği sayfalar) ve neyi dışarıda bıraktığını söyleyen bir
`note` taşır. Gözden geçirilebilir varsayılanlar, hukuki tavsiye değil: birkaç resmi kaynak
birbiriyle çelişir ve not hangi değerin neden seçildiğini söyler.

## Adaptörler

| alt yol | framework | kapı nerede durur |
|---|---|---|
| `proactive-gate/ai-sdk` | Vercel AI SDK | bir aracın `needsApproval` sorusunu yanıtlar (çevrimdışı çalışan örnek: [`examples/ai-sdk/`](examples/ai-sdk/)) |
| `proactive-gate/mastra` | Mastra | gönderimden önce bir çıktı işlemcisi (çevrimdışı çalışan örnek: [`examples/mastra/`](examples/mastra/)) |
| `proactive-gate/langchain` | LangChain | gönderim aracının çevresinde middleware |
| `proactive-gate/openai-agents` | OpenAI Agents | bir guardrail |
| `npx proactive-gate hook` | Claude Code | bir `PreToolUse` kancası ([`examples/claude-code-hook.json`](examples/claude-code-hook.json)) |

Adaptörler framework paketine değil, çağrının biçimine göre tiplenmiştir; başka bir şey
kurmak gerekmez. Her biri kapının gerekçesiyle reddeder ve onayda bütçeyi tüketir.

## Python

```
pip install proactive-gate
```

`python/` sapan bir port değil, bir kardeştir: `spec/fixtures` altındaki her senaryoyu senkron
`Gate` ve `AsyncGate` (Redis, `redis.asyncio` üzerinden) ile geçer; mypy strict, CI'da Python
3.11 ve 3.13. Bkz. [`python/README.md`](python/README.md).

## Sözleşme ve ikinci bir uygulama yazmak

[`spec/SPEC.md`](spec/SPEC.md) davranışı numaralı gereksinimler olarak yazar;
[`spec/fixtures`](spec/fixtures) dile bağlı olmayan senaryoları tutar: America/New_York'taki
yaz saati kenarı, Pacific/Apia, 2031'de bir duvar saati senaryosu, atomik commit, ISO haftası,
erteleme, gölge modu, isteğe bağlı kontroller ve dört hazır paket. TypeScript ve Python
testleri hepsini çalıştırır; `npx proactive-gate replay --fixtures spec/fixtures` komut
satırından çalıştırır. Üçüncü bir uygulama bu kaynaktan değil, senaryolardan başlar.

## Bütçe evaluate'te değil, commit'te uygulanır

İki örnek aynı kullanıcı için aynı adayı değerlendirebilir, ikisi de beşte dördün kullanıldığını
görebilir ve ikisi de göndermeye karar verebilir. Bir sınırı yarış durumuna karşı güvenle
uygulayabileceğiniz tek yer, göndermeden hemen önceki atomik artırmadır:

```ts
const decision = await gate.evaluate(input);        // reads the counter
if (decision.allowed && await gate.commit(decision, input)) {   // INCR, returns false on the sixth
  await send(...);
}
```

`RedisStore`, `INCR` kullanır ve günün TTL'sini ilk artırmada ekler. Sayaç kullanıcının yerel
gününe göre anahtarlanır, bu yüzden bütçe UTC'de değil kullanıcının gece yarısında sıfırlanır.

## Bilerek açık başarısız olur

Depoya bağlı bir kontrol hata fırlattığında (Redis düştü), varsayılan adayı geçirir ve ize
`outcome: "skip", reason: "check threw (…); failing open"` yazar. Bir önbellek kesintisi, bütün
amacı konuşmak olan bir ürünün her kullanıcısını susturmamalıdır. Ürününüz sessiz kalmayı
tercih ediyorsa `onStoreError: "closed"` geçin; aynı hata, kontrolü adıyla anan bir ret olur.

## Bir politikayı yayınlamadan önce bir günü yeniden oynatın

CLI, `{ user, candidate, now }` satırlarından oluşan bir JSONL dosyası alır ve bir politikanın
ne yapacağını raporlar. `--commit`, üretimde olduğu gibi bütçeyi sırayla tüketir.

```
npx proactive-gate replay examples/day.jsonl --commit
```

```
17 candidates  ·  7 allowed (41.2%)  ·  10 rejected

check        rejected  example
---------------------------------------------------------------
intensity           3  priority low is below the "normal" intensity floor (normal)
consent             3  user has not consented to proactive behaviour
mode                2  operating mode "focus" does not allow proactive messages
quietHours          1  quiet hours 22:00 to 08:00 Europe/Istanbul; priority normal is below the floor (critical)
dailyBudget         1  daily budget of 5 used (5)
```

`--policy examples/policy.js` kendi kapınızı yükler; `--json` bir not defteri için satır başına
tam bir karar basar. Bir haftalık gerçek adayı önerilen bir politikaya karşı oynatın; izin oranını
ve sessizlik nedenlerini tek bir kullanıcı öğrenmeden önce bilirsiniz.

## Olandan öğrenmek

```ts
await gate.record(user, candidate, "dismissed");   // feeds dismissalCooldown
await gate.record(user, candidate, "acted");       // recorded for you to extend
await gate.inspect(user);                          // { budgetUsed, dismissals }
```

Sessizlik ölçülebilir olmalıdır, yoksa bahaneye dönüşür. Her kararı `onDecision` ile
kaydedin; izin oranı, en sık ret nedenleri ve izin verilenlerin reddedilme oranı, kapının
ayarlı olup olmadığını söyleyen üç sayıdır.

## Bunu yapmaz

- Neyin söylenmeye değer olduğuna karar vermez. O üreten yarıdır ve modelinize ve ürününüze
  aittir.
- Değeri dikkate karşı puanlamaz. `adaptiveTiming`, kullanıcının bir sonraki iyi anı için
  kendi modelinize bir kancadır; paket böyle bir model içermez.
- Ürünler arasında koordinasyon yapmaz. Üç ajan her biri üçlük bir bütçeye uyarsa kullanıcı
  yine dokuz alır. Ajanlar arası katman ayrı bir problemdir.
- Rıza hukukunun yerine geçmez. `consent()` sizin belirlediğiniz bir boolean'ı kontrol eder;
  onu nasıl aldığınız size aittir.

## Nereden geliyor

Bu, Şubat 2026'dan beri tek başıma geliştirdiğim proaktif asistan
[LILA](https://efe-genc-portfolio.vercel.app/projects/lila/)'nın teslim kapısıdır; çıkarılıp
framework'ten bağımsız hâle getirildi. On iki kontrolün sırası, güven rampası, otuzda üç
soğuması ve açık başarısız olan bütçe, üretimde verilmiş ve
[The hardest part of a proactive assistant is knowing when not to speak](https://efe-genc-portfolio.vercel.app/writing/knowing-when-not-to-speak/)
yazısında savunulmuş kararlardır. Tian Pan'ın
[bildirim bütçesi](https://tianpan.co/blog/2026-05-13-background-agents-notification-budget-attention-economy)
yazısı aynı davayı ürün tarafından savunur ve günde üç ile beş arası bir tavan önerir;
`defaultChecks({ dailyLimit })` varsayılanı beştir.

Biçimin daha eski akrabaları var. Matrix push kuralları, ilk eşleşen kuralın karar verdiği
sıralı bir listedir. Android bildirim kanalları ve iOS kesinti seviyeleri kullanıcıya tür
başına bir anahtar ve sessiz saati aşan bir öncelik tabanı verir. Horvitz'in karma girişim
çalışmaları iki isteğe bağlı kontrolü sağladı. Bu paket o fikirleri izli tek bir listeye
koyar ve onların dışarıda bıraktığı parçayı ekler: gönderim anında tüketilen bütçe.

## Geliştirme

```
npm ci
npm test               # tsc build, spec-lint, then node:test over dist/test
cd python && pytest    # the Python sibling against the same fixtures
```

MIT.
