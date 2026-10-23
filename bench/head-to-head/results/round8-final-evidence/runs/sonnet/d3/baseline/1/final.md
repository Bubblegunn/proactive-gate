`bot.mjs` is written in the project directory, and it passed the checks I ran. Nothing was sent.

**How it works**
- **Day key:** each call works out the customer's local calendar day from `now` and `timeZone`, using `Intl`. It never reads the system clock.
- **Reservations:** every reservation is a small file in `$STATE_DIR/marketing-cap/`. The name combines a hash of `userId`, the local day and a slot number (1 or 2).
- **Concurrency:** the file is created exclusively, so the operating system lets only one caller create a given slot, across processes and across concurrent calls in one process. There is no lock to go stale if a worker dies. The directory is created on demand.
- **Restarts:** the files stay on disk, so restarts don't reset the count.
- **Result:** if a slot is free, the call returns `{ allowed: true, rule: "" }`. If both slots exist, it returns `{ allowed: false, rule: "daily-cap" }`.
- **Logs:** each slot file records the user, time zone, day, channel and timestamp of the message that took it. Reading the two files for a user and day shows which messages were counted. You can then tell which later message should have been held.

**What I checked**
- **Concurrent callers:** 6 separate Node processes, each making 5 simultaneous calls for the same customer (30 calls in total), left exactly 2 slot files on disk. I didn't capture the allowed/denied counts printed by that run, because of a typo in my shell command.
- **Midnight in the customer's time zone:** for Tokyo, 14:59Z (23:59 local) was still the old day, which was already full, so 0 were allowed. At 15:00Z (midnight local) the new day allowed 2 more.
- **Time zone separation:** for Los Angeles, 07:59Z and 08:00Z fell on different local days and each allowed 2.

**Behaviour to know about**
- **Bad input throws:** an invalid `channel`, `timeZone`, `now`, or unset `STATE_DIR` throws instead of returning a result. A worker that doesn't catch it won't send.
- **Crash before sending:** a worker that crashes after `reserve` but before sending still uses up a slot. This errs on the side of sending too few messages, not too many.
- **Old files stay:** nothing deletes old slot files. A cleanup job can safely remove files whose day is more than a couple of days old.
- **Time zone changes:** if a customer's `timeZone` changes during a day, the counts for the two zones are kept separately.
