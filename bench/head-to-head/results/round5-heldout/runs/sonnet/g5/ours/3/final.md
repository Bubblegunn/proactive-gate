Ben `bot.mjs` dosyasını yazdım ve çalıştırarak denedim. Dosya, çalışma dizininin kökünde. Hiçbir şey göndermiyor.

`decideWhatsApp(message, now)` şu kurallara göre karar veriyor:

- **Opt-in:** `optedIn` tam olarak `true` değilse mesaj hem text hem template için `not_opted_in` koduyla reddediliyor.
- **Template:** Opt-in varsa her zaman izin veriliyor.
- **Text:** Hasta bize son yazdığı andan itibaren 24 saat içindeyse izin veriliyor.
  - Hasta hiç yazmadıysa `no_inbound_message` dönüyor.
  - 24 saat dolduysa `service_window_closed` dönüyor. Tam 24. saatte pencere kapalı sayılıyor.
- **Zaman damgası:** `lastInboundTimestamp`, Meta'nın tanımına göre Unix saniyesi olarak okunuyor.
  - Milisaniye gibi anlamsız ya da sayı olmayan değerler, ve `now`'dan 5 dakikadan fazla ilerideki değerler `invalid_inbound_timestamp` koduyla reddediliyor.
  - 5 dakikalık pay, sunucu saati ile Meta saati arasındaki küçük farklar için.
- **Diğer kodlar:** Geçersiz `type` için `invalid_message_type`, geçersiz `now` için `invalid_now` dönüyor. Her kuralın kodu farklı.

Küçük bir Node betiğiyle 9 durumu denedim ve hepsi beklenen sonucu verdi:

- Pencere içi text: 1 saat ve 23 saat 59 dakika 59 saniye önce yazan hasta için izin verildi.
- Pencere dışı text: tam 24 saat önce yazan hasta reddedildi.
- Milisaniye olarak verilmiş zaman damgası reddedildi.
- Hiç yazmamış hastaya text reddedildi, template'e izin verildi.
- Opt-in vermemiş hastaya hem text hem template reddedildi.
- 25 saat önce yazan hastaya template'e izin verildi.

Meta bir mesajı bu kontrollerin dışında başka nedenlerle de reddedebilir. Örneğin template'in onaylı olup olmadığı, kalite puanı ve gönderim limitleri burada kontrol edilmiyor.
