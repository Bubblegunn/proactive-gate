Yazdım: `bot.mjs`, `decideWhatsApp(message, now)` dışa aktarıyor. Hiçbir şey göndermedi. Çalıştığını örnek mesajlarla Node'da denedim ve sonuçlar beklediğim gibi çıktı.

**Kurallar** (bu sırayla uygulanır, ilk takılan kural kodunu döndürür):

| Kod | Ne zaman |
|---|---|
| `invalid_message_type` | `type` ne `"text"` ne `"template"`. |
| `opt_in_missing` | `contact.optedIn` tam olarak `true` değil. Bu hem text hem template için geçerli. |
| `invalid_clock` | Text mesajda `now` geçerli bir `Date` değil. |
| `no_customer_service_window` | Text mesaj, hasta bize hiç yazmamış (`lastInboundTimestamp` null). |
| `invalid_inbound_timestamp` | Zaman damgası sadece rakamlardan oluşmuyor, ya da `now`'dan 5 dakikadan fazla ilerde. Milisaniye gibi yanlış birimler de buraya düşer. |
| `customer_service_window_expired` | Hastanın son mesajından beri 24 saat veya daha fazla geçmiş. |

Opt-in'i olan template her zaman geçer. Template için zaman damgasına bakılmaz.

**Zaman damgası:** Meta'nın webhook `timestamp` alanı saniye cinsinden Unix zamanıdır. Kod bunu saniye olarak okuyor, `now`'ı 1000'e bölerek karşılaştırıyor.

**Kararlarım:**
- **Sınır:** Tam 24 saat dolduğu an pencere kapalı sayılıyor. Sınırda mesajı reddetmeyi seçtim, çünkü Meta reddederse sorun yaşarız.
- **Saat farkı payı:** Sunucu saatimiz Meta'dan biraz geride kalabilir. Bu yüzden 5 dakikaya kadar ileri tarihli zaman damgasını kabul ediyorum. Bu payı `CLOCK_SKEW_SECONDS` sabitiyle değiştirebilirsiniz.
- **Hiç yazmamış hasta:** "Hiç yazmamış" ile "süresi dolmuş" farklı kurallar olduğu için ayrı kod verdim.

**Denediklerim:**
- Pencere içindeki text mesaj geçti.
- 24 saatin tam sınırı reddedildi, 1 saniye öncesi kabul edildi.
- Opt-in'siz mesaj reddedildi.
- `null` zaman damgasıyla text reddedildi, aynı durumda template geçti.
- Milisaniye, `"abc"` ve ileri tarihli zaman damgaları reddedildi.
- Bilinmeyen `type` reddedildi.

Bunları bir test dosyası olarak repoya koymadım. Denemeler `/tmp` altında geçici betiklerle yapıldı.
