Yazdım: `bot.mjs`, `decideWhatsApp(message, now)` dışa aktarıyor. Gönderim yapmıyor. Ayrı bir test betiğiyle 7 senaryoyu denedim ve hepsi beklenen sonucu verdi. Test betiği repoda yok.

**Kurallar (bu sırayla kontrol edilir):**
1. `type`, `"text"` veya `"template"` değilse `unknown_message_type` döner.
2. `optedIn` tam olarak `true` değilse `not_opted_in` döner. Bu kural hem metin hem şablon için geçerli.
3. Şablon mesajı bu noktadan sonra serbest. Şablonlar 24 saat penceresinin dışında da gönderilebilir.
4. Metin mesajında `lastInboundTimestamp` null ise `no_inbound_message` döner.
5. Metin mesajında zaman damgası geçerli değilse `invalid_timestamp` döner. Geçerli sayılan biçim, en çok 15 haneli bir tamsayı dizesidir.
6. Zaman damgası, sunucu saatinden 5 dakikadan fazla ilerideyse yine `invalid_timestamp` döner. Küçük saat kaymalarına izin veriyorum.
7. Son hasta mesajının üzerinden 24 saat veya daha fazla geçtiyse `outside_24h_window` döner. Tam 24. saatte de reddeder, yani sınırda temkinli davranır.

**Webhook zaman damgası:** Meta bu değeri Unix saniyesi olarak verir, milisaniye olarak değil. Kod saniye olarak okuyor. Yanlışlıkla milisaniye gelirse (13 hane) değer geleceğe düşer ve `invalid_timestamp` ile reddedilir. Böylece pencere yanlışlıkla açık kalmaz.

**Test sonuçları:**
- Pencere içindeki metin mesajı geçti.
- 23 saat önceki zaman damgasına karşılık sunucu saati +1 saat olunca metin reddedildi (`outside_24h_window`).
- Milisaniye biçimindeki zaman damgası reddedildi (`invalid_timestamp`).
- Hiç yazmamış hastaya metin gönderimi reddedildi (`no_inbound_message`), şablon ise geçti.
- Opt-in vermeyen hastaya hem metin hem şablon reddedildi (`not_opted_in`).

Geçersiz bir zaman damgası şablon mesajlarını etkilemez. Şablon kararı o alana bakmaz.
