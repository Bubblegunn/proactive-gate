# Handoff: yerel oturum, organizasyon API key'i ile (2026-10-22)

Bu dosya beş reponun hepsi için ortak handoff'tur: Bubblegunn/workproof, surviving-lines, product-engineer,
ai-slop-linter, proactive-gate. Her repoda `plugin-leadership` branch'inde `docs/HANDOFF-LOCAL.md` olarak da durur.
Bağlayıcı kurallar `docs/HANDOFF-CLOUD.md` ve her reponun `docs/HEAD-TO-HEAD.md` dosyasındadır; bu dosya onların
yerini almaz, üstüne bugünkü durumu, bütçeyi ve birinci olmak için yapılacak işleri ekler.

## 0. Neden yerel, neden şimdi

- Cloud oturumları `ANTHROPIC_API_KEY`'i kimlik doğrulamada kullanmıyor (environment ayarları bunu açıkça söylüyor);
  oradaki her koşu plan kotasından gidiyor ve plan kotası bitmek üzere. Organizasyonun **200 $ promosyon API kredisi**
  yalnız yerelde, key ile çalışan `claude -p` koşularından harcanabilir.
- **Kredinin son günü 2026-10-29.** Bütçe ve sıra buna göre (bölüm 3).
- Cloud environment ayarlarına key yazıldıysa oradan sil; o alan herkese görünür. Yazıldıysa key'i Console'dan iptal
  edip yenisini oluştur.

## 1. Kurulum (her repo için bir kez)

```sh
export ANTHROPIC_API_KEY=...          # Console'daki org key; dosyaya, commit'e, log'a asla yazma
cd ~/<repo> && git fetch origin && git checkout plugin-leadership && git pull --ff-only
git status --short                    # temiz olmalı
```

**Fatura kontrolü (zorunlu, her repoda ilk koşudan önce):**

1. Benchmark runner'ının kullandığı ortamla (aynı throw-away HOME, aynı PATH, aynı env temizliği) tek bir Haiku çağrısı yap:
   `claude -p --model claude-haiku-5-5 --output-format stream-json --verbose "ok"`
   init olayındaki `apiKeySource` **`ANTHROPIC_API_KEY`** olmalı. `none` ise koşu plan girişinden gidiyor demektir: dur.
2. Runner'lar ortamı temizliyor olabilir (ai-slop-linter bwrap + scrubbed env; product-engineer ve workproof
   throw-away HOME + `mkhome.sh`; proactive-gate throw-away HOME). Key'in alt sürece geçtiğini runner'ın kendi
   argv'siyle doğrula; geçmiyorsa runner'a yalnız `ANTHROPIC_API_KEY`'i geçirecek en küçük değişikliği yap ve commit
   mesajında yaz. macOS'ta `mkhome.sh` Keychain'i bağlıyor; key varken hangisinin kullanıldığını yine `apiKeySource`
   söyler.
3. Console → Usage'da o tek çağrının promosyon kredisinden düştüğünü gör. Ödeme yöntemi ekleme.
4. Maliyet takibi: her koşunun `total_cost_usd` değerini topla; repo bütçesinin %80'ine gelince dur ve raporla.

## 2. Değişmeyen kurallar (kısa hatırlatma, tam metin HANDOFF-CLOUD.md)

- **Kazanma kuralı:** Rule B (her görevde ortalamamız diğer her koldan kesin yüksek; biri tavandaysa biz de tavanda),
  Rule A (kaybettiğimiz puan en iyi diğer kolun kaybının en fazla %80'i), yalnız outcome kriterleri, rakip = düz ve
  invoked kolunun iyisi. Final gate: held-out + Haiku/Opus (görev başına 1) + bağımsız %10 yeniden notlama.
- **Objektiflik (pazarlık yok):** Sonuç görüldükten sonra kriter, script kontrolü, görev veya kural değiştirilmez.
  Görev değişecekse yeni varyant kod değişikliğinden ÖNCE dondurulur. Held-out görevler (`heldout-2026-10` branch'i)
  yalnız final gate adımında, ayrı klasöre açılır; açıldıktan sonra ürün değişmez. Görülmüş held-out bir daha held-out
  sayılmaz. "Birinci" iddiası yalnız tam gate geçince ve kapsamıyla (görev sayısı, model, tarih) yazılır. Viral
  paylaşımın değeri buna bağlı: tekrar koşulabilir, dürüst bir tablo.
- **Rakiplerden alma:** Fikir serbest. Kod alınacaksa lisansa bak: MIT/Apache/BSD/CC0 atıfla (`THIRD-PARTY-NOTICES.md`),
  GPL/AGPL/lisanssız alma. Rakiple iletişime geçme.
- **Güvenlik:** Vaara asla çalıştırılmaz. Her rakip koşusunun önce/sonrasında `hooks` ve `mcpServers` hash guard'ı.
  Yalnız `git archive` kopyası benchmark edilir. Çalışma ağacında checkout/restore/stash/reset/clean yok.
  Paralellik 2. Rate limit ile düşen hücre tekrar koşulur, notlanmaz.
- **Commit:** conventional başlık + teknik gövde + "Sade dil (teknik olmayan biri için):" bloğu ("- Ne yapıldı:",
  "- Ne işe yarar:") + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. product-engineer'da ek olarak
  "For the customer:" bloğu (hook zorunlu kılıyor). Kişisel e-posta, gerçek anahtar, ham transcript commit edilmez;
  yalnız .md özetleri.
- **Sahibin onayı gerekir:** merge, `main`'e push, release, npm publish, PR, directory submission, herhangi bir
  public paylaşım.
- **Yöntem:** repo başına bir controller; implementer Haiku/Sonnet, reviewer Sonnet. Araştırma ve koşular `claude -p`
  ile (key'den ödenir).

## 3. Bütçe ve sıra (200 $, 2026-10-29'a kadar)

Kazanmaya yakınlığa göre sıralı. Tahminler önceki koşuların gerçek `total_cost_usd` toplamlarından.

| Sıra | Repo | İş | Tahmini maliyet | Tavan |
|---|---|---|---|---|
| 1 | surviving-lines | round 5 (T3 ürün düzeltmesi) + tam round + final gate | ~10 $ tam round, ~10 $ final gate | 25 $ |
| 2 | product-engineer | round 4 (T3, H2, H4, H6 + yeni H1 varyantı), tam round | ~21 $ + notlama ~5 $ | 30 $ |
| 3 | ai-slop-linter | round 3 tam round (round-2 klasörü yok) | ~28 $ + 72 notlama | 35 $ |
| 4 | workproof | round 8: düzeltme, public yeniden koşu, yeni held-out, final gate | ~2 $ + ~18 $ + F9 | 45 $ |
| 5 | proactive-gate | araştırma + round 4 (Haiku önce, sonra Sonnet) | ~8 $ + ~15 $ | 40 $ |
| | Rezerv | final gate'ler, tekrarlar | | 25 $ |

Bir repo gate'i geçmiyorsa ve bir round daha kazanma ihtimalini somut olarak artırmıyorsa, parayı geçme ihtimali
yüksek repoya kaydır. Kaybedilen görevi "biraz daha prompt" ile değil, transcript'teki somut nedene göre düzelt.

## 4. Repo bazında: durum, neden kaybediyoruz, ne yapılacak

### 4.1 surviving-lines (en yakın)

- **Durum:** round 4 (`e833a7d`, araç `747031f`): 49.67/51; project-pilot 39.00, base 38.33. Rule A geçiyor
  (1.33 kayıp, sınır 9.60). Rule B yalnız **T3**'te kalıyor: ours 4.33 = base 4.33.
- **Neden:** 3 koşunun 2'sinde ajan Alejandro grubu için tek adresli `.mailmap` satırı (`Name <a>`) yazdı; donuk
  `one_address` kontrolü iki adresli biçim (`Name <a> alias <a>`) istiyor. Kök neden: prompt hint grubu gösteriyor
  ama `--identities` bu grup için satır basmıyor, ajan kendisi yazıyor.
- **Yapılacak (round 5):**
  1. Ürün: `--identities` ve prompt hint, aynı adres/farklı isim gruplarının **her biri** için iki adresli satırı
     birebir bassın; ajan kopyalasın, yazmasın. Test + `npm test` + `claude plugin validate .` + review.
  2. Kontrol script'i değiştirilmez (önerim). Sahibin farklı karar vermesi gerekirse önce kayda geçir ve dondur.
  3. Tam round (round 3/4 transcript'leri repoda yok): HEAD-TO-HEAD.md "Resume" adım 3'teki `run-all.sh` komutu,
     project-pilot `bf6eabe`. Notla (`grade.py`, parse hatası kalmayana kadar), `publish-results.sh`.
  4. Geçerse final gate: held-out (tüm kollar ×3), F9 (Haiku/Opus ×1), F6 %10 audit.
- **Araştırma (küçük):** directory'deki diğer git-authorship/ownership eklentileri ve `git shortlog`/`git-fame`/
  `git-quick-stats` gibi araçların kimlik birleştirme yaklaşımı; yalnız T3 ve held-out genellemesi için.

### 4.2 product-engineer

- **Durum:** round 3 (`0410631`, kod `bc7b595`): core 25.00/30, en iyi rakip gwc 21.33. **Rule A geçiyor** (5.00 kayıp,
  sınır 6.93). Gate kalıyor: T3 beraber (4.67), tavan kuralı H2 (4.67 vs 5.00), H4 beraber (4.33), H6 beraber (4.67).
  H1 doymuş (herkes 5.00), daha zor varyant gerekiyor.
- **Neden ve düzeltme (HEAD-TO-HEAD.md "What round 4 would change"):**
  - T3: PR açıklaması izlemediği kısımlara kefil oluyor ("formatting only", "behaves as before"). Kural: diff'in her
    parçası için ne gösterdiğini söyle, izlemediğin parçaya kefil olma.
  - H2: test dosyası değiştirmeyen fix, raporlamadan önce önce-kırmızı-sonra-yeşil test eklesin (core kuralda kontrol).
  - H4: refactor cevabı taşınan kodu kapsayan testleri adıyla söylesin, "davranış değişmedi"yi yalnız "testler
    gösteriyor" diye kursun; üç satırlık şekil kalsın.
  - H6: sade dil yeniden yazımı kaynakta olmayan bölüm eklemesin, daha sade kelime yoksa koşulun kelimesini korusun.
  - H1: daha zor varyant, kod değişikliğinden önce dondur.
- **Yapılacak:** freeze → ürün değişiklikleri (her biri ayrı reviewer) → `npm test` → tam round 4 (312 oturum + 312
  notlama; "Resume" bölümündeki `fetch-arms.sh`, `runall.sh`, `grade.mjs`, `summarize.mjs`, `publish.sh`). Ucuz ara
  ölçüm istenirse yalnız açık görevler (T3, H1 yeni, H2, H4, H6) tüm kollarla (~8 $). Geçerse final gate (held-out
  henüz yazılmadı: kodu görmemiş bir agent `heldout-2026-10` branch'indeki görevleri kullanır).
- **Araştırma:** dod-guard, git-weekly-changelog (gwc), ISO 24495 sade dil kaynakları; PR açıklaması ve sürüm notu
  üreten açık kaynak araçlar (ör. release-please, git-cliff, conventional-changelog) ve "unverified claim" tespiti
  üzerine makaleler. Hedef: T3/H4 tipi aşırı-kefil olma hatalarına deterministik kontrol.

### 4.3 ai-slop-linter

- **Durum:** round 2 (`4729e8f`, kod `8cfeb5c`): ours 56.67/60, **toplamda birinci** (blader-inv 56.00). Rule A kıl
  payı kalıyor (3.33 kayıp, sınır 3.20). Rule B h9, h14, h17, h18'de kalıyor.
- **Neden:** h9/h17/h18'deki tüm C2 kayıpları, rakip kataloglarından (unslop, everwrite) bir "tell"in yeniden
  yazımda kalması; h14'te bir koşu C4'ü kaçırdı.
- **Round 3 ürün değişiklikleri zaten commit'li ama ölçülmedi:** `0f742c6` (araştırma raporu
  `docs/ROUND3-RESEARCH.md`), `f417fa7`, `4e3b226`, `d0d8cf3`, `3cd64d9`, `995a5c7`. 934/940 test geçiyor.
- **Yapılacak:** önce h9/h17/h18'in başarısız ours çıktılarını kriter metniyle karşılaştır ve h14 C4'ü incele (ham
  çıktılar cloud makinesindeydi ve kayboldu; gerekirse bu görevlerde yalnız ours ×3 ucuz bir tanı koşusu yap). Sonra
  tam round 3: `bash bench/head-to-head/rerun.sh --iterations 3 --parallel 2 --commit <sha> --out <repo dışı klasör>`,
  ardından `grade-run.sh`, `grade-collect.mjs`, `summarize.mjs`, `publish.sh`.
- **Açık:** "Rules for anyone continuing" bölümündeki trailer kuralı: Sonnet/Haiku diyen Co-Authored-By satırları
  Opus 5.5'e çevrilecek (sahibin onayıyla, force push gerektirir).
- **Not:** referans kataloglar unslop ve everwrite'tan uyarlandı (MIT, atıf var); bu görevlerdeki galibiyet
  yayınlanırken bu açıklama da yazılmalı.

### 4.4 workproof

- **Durum:** public set geçiyor (34.33 vs 23.33/35). **Final gate kaldı** (`04052f3`): held-out 7.67 vs 12.67/15
  (JD Resume Tailor invoked). H1 ve H3 kayıp, H2 kazanıldı.
- **Neden:**
  - H1: repo public Express'e benzeyince skill 3 koşunun 2'sinde durup soru sordu, `./evidence/` paketini kurmadı (0 puan).
  - H3: `workproof verdict` yabancı formatlı `report.json`'u reddetti; ajan git ile saymadı. Düz Claude 4.67 aldı.
  - H2: geçti ama sohbet cevabında e-posta adresleri ve benzer isimli meslektaşın adı sızdı (C4 her koşuda kaldı).
- **Yapılacak (round 8):** önce üç kuralı dondur, sonra ürün: (1) public görünümlü repoda durma, uyarıyı paketin
  içine bir satır olarak yaz; (2) yabancı formatlı raporda CLI veya skill düz git sayımına düşsün (commit ve satır
  sayıları git'ten); (3) gizlilik varsayılanları son sohbet cevabını da kapsasın. Public seti yeniden koş. Kodu
  görmemiş bir agent'a **yeni** held-out set yazdır (yeni branch); agent'lar çalışma ağacını görmeyecek şekilde koş.
  Final gate sırası: held-out → F9 → F6. Eski H1-H3 yalnız tanı için kullanılabilir.
- **Araştırma:** GapToGrowth, JD Resume Tailor, receipts nasıl yabancı rapor/repo durumunu ele alıyor; açık kaynak
  "git contribution stats" araçları (git-fame, gitinspector, git-quick-stats) ile çapraz doğrulama fikri.

### 4.5 proactive-gate (en uzak)

- **Durum:** round 3 (`5f4a3f8`, kod `30fdfae`) iki modelde de kaldı (36 üzerinden). Sonnet: ours 22.33, knock 25.67,
  baseline 24.00, knock-inv 23.00. Haiku: ours 22.67, baseline 25.33, knock 24.33, knock-inv 24.33. Rule B yalnız
  Sonnet Z5, Haiku Z4/Z6'da sağlanıyor; Rule A, Sonnet Z1 tavan kuralı ve maliyet kuralı (ours/baseline maliyet
  Sonnet 1.94x, Haiku 1.27x) kalıyor. Spec'e göre round 3 son izinli turdu; **sahip round 4'ü istedi** (araştırma +
  implementasyon + benchmark).
- **Neden (transcript'lerden):** Sonnet Z4 3/3 sıfır: çözümler `STATE_DIR`'ı import anında okuyup atıyor, checker
  sonradan kuruyor. Sonnet Z1: opt-out yeni süreçte korunmuyor (ikinci süreç opt-out kullanıcıya izin verdi). Skill
  yolu el yazımından pahalı (Sonnet'te 249 vs 161 satır, 11.8 vs 3.7 tur).
- **Faz 1, derin araştırma (`claude -p` + WebSearch/WebFetch, Sonnet, ~8 $):**
  - knock ve knock-inv kollarının kaynağı (repo, sürüm, skill metni): gate tasarımı, durum yönetimi, varsayılanlar,
    neden Z görevlerinde bizden iyi. Görev görev bizim kodla karşılaştır.
  - GitHub, npm/PyPI, Hugging Face (model, dataset, Space), Claude Code plugin dizini
    (`claude plugin list --available --json`), arXiv ve bloglarda "proactive assistant / nudge / notification gating /
    rate limiting / opt-out / human-in-the-loop" konuları.
  - Çıktı `docs/RESEARCH-ROUND4.md`: URL, lisans, alınacak teknik, hangi Z görevine/kurala etkisi, öncelik. URL'leri
    örnekle doğrula.
- **Faz 2, implementasyon:** `STATE_DIR` tembel okuma (ilk kullanımda) + test; opt-out her süreçte ortak store'dan
  okunsun; skill metnini kısalt ve skill yolunu el yazımından ucuz yap (maliyet kuralı); araştırmadan öncelikli
  eksikler. Kriter ve checker değişmez. Z1-Z6 için yeni donuk varyantlar gerekiyorsa koddan önce dondur.
- **Faz 3, benchmark:** önce Haiku Z1-Z6 4 kol ×3 (~1.5 $) ile yön kontrolü. Birinci değilsek bir iterasyon daha.
  Sonra Sonnet (~13.5 $). Z1-Z6'ya göre ayar yapıldığı için aşırı uyum riski var; gerçek kanıt held-out
  (`heldout-2026-10`) ile gelir.
- **Dürüst not:** iki model de kütüphanesiz basit gate'leri doğru ve ucuz yazıyor. Round 4 de geçmezse ürünün iddiası
  "daha az kodla/daha ucuz doğru gate" olarak yeniden çerçevelenmeli ya da bu repo lansman listesinden çıkarılmalı.

## 5. Final gate ve yayın (her repo için, gate geçtikten sonra)

1. `git fetch origin heldout-2026-10` → ayrı klasör → held-out tüm kollar ×3 (Sonnet). Ürün artık değişmez.
2. F9: Haiku ve Opus, görev başına 1 koşu (ours, görev başına en iyi rakip kolu, baseline).
3. F6: kodu görmemiş yeni bir agent rastgele %10 hücreyi yeniden koşar ve notlar.
4. HEAD-TO-HEAD.md'ye "Results, final gate" + kapsamlı sonuç cümlesi. Push etme, tag atma, yayınlama; sahibe sun.
5. Lansman için gereken sürümler: ai-slop-linter 0.2.0, surviving-lines 0.4.0, product-engineer 0.8.0, workproof 0.8.0,
   proactive-gate sonraki minor (`npm run release -- X.Y.Z`, merge'den sonra, sahibin onayıyla).

## 6. Sahibin kararı bekleyen konular

- proactive-gate branch'i README, README.tr ve CHANGELOG'daki eski bir ürün bahsini sildi: merge'den önce geri
  konacak mı?
- npm token'ını yenile (21 Ekim'de bir agent çıktısında göründü); istersen Tavily key'ini de.
- Cloud environment ayarlarına girilen API key: sil, girildiyse iptal et ve yenile.
- dev.to taslağı: tablodaki gerçek isimler ve AI açıklaması; dash varsayılanı; VS Code Marketplace publisher.
- Bir eklenti hook'unun verdiği "Stack overflow" hatası (incelenmedi).
- surviving-lines T3 kontrolü: değiştirilmemesi önerilir (bölüm 4.1).
- ai-slop-linter trailer yeniden yazımı (force push).

## 7. Yerel oturum için başlangıç prompt'u

Her repoda ayrı bir Claude Code oturumu aç (`ANTHROPIC_API_KEY` export edilmiş terminalde) ve şunu ver:

> plugin-leadership branch'ini pull et. docs/HANDOFF-LOCAL.md, docs/HANDOFF-CLOUD.md ve docs/HEAD-TO-HEAD.md
> (son "Results" ve "Resume" bölümleri) dosyalarını oku. Önce HANDOFF-LOCAL.md bölüm 1'deki fatura kontrolünü yap;
> `apiKeySource` ANTHROPIC_API_KEY değilse dur. Sonra bölüm 4'te bu repo için yazılı işi yap; bütçe tavanı bölüm 3'te.
> Kurallar bölüm 2'de; merge, release, publish, PR ve public paylaşım yok. Bitince: skorlar (kol bazında), geçti/kaldı,
> harcanan tutar, sıradaki adım.
