Yazdım: `bot.mjs`, `decideWhatsApp(message, now)` dışa aktarıyor. Mesaj göndermiyor. 10 senaryoluk bir betikle çalıştırdım ve hepsi beklenen sonucu verdi.

**Kurallar, bu sırayla:**
1. `type` "text" ya da "template" değilse `unknown_message_type` döner.
2. `optedIn` tam olarak `true` değilse `no_opt_in` döner. Bu kural hem text hem template için geçerli, ve hasta az önce yazmış olsa bile işler.
3. Template mesaj, opt-in varsa her zaman geçer. Pencere kontrolü yapılmaz ve `lastInboundTimestamp` hiç okunmaz.
4. Text mesaj, hastanın son mesajından beri 24 saatlik müşteri hizmetleri penceresi açıksa geçer.
   - `lastInboundTimestamp` `null` ise `no_inbound_message` döner.
   - Değer Unix saniyesi olarak okunan rakamlardan oluşan bir string değilse `invalid_inbound_timestamp` döner.
   - Pencere kapandıysa `outside_24h_window` döner.

**Zaman damgası:** Meta'nın webhook `timestamp` alanı saniye cinsindendir, milisaniye değil. Kod bunu saniye olarak okuyor. Milisaniye gibi görünen bir değer (`Date.now()` biçimi) `invalid_inbound_timestamp` ile reddediliyor. Yoksa çok geniş bir pencere açık sayılırdı.

**Sınır kararları:**
- Son mesajın üzerinden tam 24 saat geçmişse pencere kapalı sayılıyor. Hata durumunda mesajı göndermemek daha güvenli.
- Zaman damgası bizim saatimizden 5 dakikadan fazla ilerideyse `invalid_inbound_timestamp` ile reddediliyor. 5 dakikaya kadar fark saat kayması sayılıyor ve kabul ediliyor. Bu 5 dakikalık eşiği ben seçtim, değiştirmek istersen koddaki `CLOCK_SKEW_SECONDS`.

**Denediğim senaryolar:**
- Pencere içindeki text geçti.
- 25 saat önceki text ve tam 24 saat önceki text reddedildi.
- Milisaniye biçimli zaman damgası reddedildi.
- `null` zaman damgalı text reddedildi.
- `null` ya da çok eski zaman damgalı template geçti.
- Opt-in olmayan text ve template reddedildi.
- Bilinmeyen `type` reddedildi.

Test betiği `/tmp/t.mjs` içinde, repoya eklemedim.
