Yazdım: `bot.mjs`. `decideWhatsApp(message, now)` dışa aktarılıyor. Dokuz senaryolu bir test çalıştırdım, hepsi beklenen sonucu verdi. Test dosyasını `/tmp/t.mjs` olarak bıraktım. Hiçbir şey göndermiyor.

Kurallar bu sırayla uygulanıyor:
1. **`invalid_clock`**: `now` geçerli bir `Date` değil.
2. **`invalid_contact`**: `contact` yok veya nesne değil.
3. **`not_opted_in`**: `optedIn` tam olarak `true` değil. Bu kural hem metin hem şablon için geçerli, yani izin yoksa hiçbir mesaj gitmiyor.
4. **Şablon**: izin varsa her zaman gider. Şablon, konuşmayı biz başlatırken kullanılabilen tek tür.
5. **`unknown_message_type`**: `type` ne `text` ne `template`.
6. **`no_inbound_message`**: metin mesajı, ama hasta bize hiç yazmamış (`null`).
7. **`invalid_inbound_timestamp`**: metin mesajı, ama zaman damgası geçerli bir sayı dizesi değil, ya da 5 dakikadan fazla gelecekte.
8. **`customer_service_window_closed`**: metin mesajı, ama hastanın son mesajı 24 saat veya daha eskiye dayanıyor. Tam 24. saatte de reddediyor.

Meta'nın `timestamp` alanı Unix zamanı olarak saniye cinsinden, UTC. Bu yüzden kod değeri saniye olarak okuyor ve `now`'ın milisaniyesini 1000'e bölüyor. Testte milisaniye cinsinden bir değer verince geçmişte kalmadığı için reddedildi. Yani milisaniye sanılırsa yanlış sonuç çıkmıyor.

Anlaşılmayan veri olduğunda mesajı göndermiyor. Sayı olmayan veya tür olarak string olmayan zaman damgaları da reddediliyor.

Opt-in için ayrıca bir süre sınırı koymadım. Şablon mesajlarda kategori ve kalite kuralları da var. Bunları Meta API'si kendisi uyguluyor, bu yüzden bu fonksiyon onlara bakmıyor.
