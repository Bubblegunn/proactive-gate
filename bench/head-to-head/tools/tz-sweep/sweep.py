import json, subprocess, random, datetime as dt, sys
import zoneinfo, os
zoneinfo.reset_tzpath(to=[os.environ["TZDIR"]])
from zoneinfo import ZoneInfo, available_timezones
UTC = dt.timezone.utc
names = json.loads(subprocess.check_output(["node","-e","console.log(JSON.stringify(Intl.supportedValuesOf('timeZone')))"]))
py = available_timezones()
zones = sorted(z for z in names if z in py)
print("zones", len(zones), "of", len(names))
rng = random.Random(7)
def off(z, t): return ZoneInfo(z), None
def loc(z, tms):
    d = dt.datetime.fromtimestamp(tms/1000, ZoneInfo(z)); return d
start = dt.datetime(2020,1,1,tzinfo=UTC); end = dt.datetime(2031,1,1,tzinfo=UTC)
trans = {}
for z in zones:
    zi = ZoneInfo(z); ts = []
    d = start; prev = d.astimezone(zi).utcoffset()
    while d < end:
        n = d + dt.timedelta(days=1); o = n.astimezone(zi).utcoffset()
        if o != prev:
            lo, hi = d, n
            while (hi-lo) > dt.timedelta(minutes=1):
                mid = lo + (hi-lo)/2
                if mid.astimezone(zi).utcoffset() == prev: lo = mid
                else: hi = mid
            ts.append(int(hi.timestamp()*1000)); 
        prev = o; d = n
    trans[z] = ts
print("transitions", sum(len(v) for v in trans.values()))
M = 60000
pts = []; ref = []
def ref_local(z, t):
    d = loc(z, t); return [d.year, d.month, d.day, d.hour, d.minute, (d.isoweekday() % 7)]
def mins(s): h, m = s.split(":"); return int(h)*60+int(m)
def ref_in(z, t, s, e):
    d = loc(z, t); x = d.hour*60 + d.minute; a, b = mins(s), mins(e)
    if a == b: return False
    return (a <= x < b) if a < b else (x >= a or x < b)
def ref_open(z, t, s, e):
    if ref_in(z, t, s, e): return t
    tt = (t//M)*M + M
    # scan forward by minute up to 60h
    for i in range(0, 60*60):
        c = tt + i*M
        if ref_in(z, c, s, e): return c
    return None
def ref_mid(z, t):
    d0 = loc(z, t).date(); tt = (t//M)*M
    for i in range(1, 60*60):
        c = tt + i*M
        if loc(z, c).date() != d0: return c
    return None
sample = []
for z in zones:
    for T in trans[z]:
        sample.append((z, T))
rng.shuffle(sample)
# gkLocal / day keys on every transition neighbourhood (cheap)
for z in zones:
    for T in trans[z]:
        for k in range(-8, 13):
            t = T + k*15*M
            pts.append({"op":"local","t":t,"zone":z}); ref.append(ref_local(z, t))
            d = loc(z, t); iso = d.isocalendar()
            pts.append({"op":"day","t":t,"zone":z}); ref.append([d.strftime("%Y-%m-%d"), "%d-W%02d"%(iso[0], iso[1]), d.strftime("%Y-%m")])
W = [("08:00","21:00"),("00:30","01:30"),("02:30","03:30"),("22:00","07:00"),("23:30","00:30")]
for z, T in sample[:350]:
    for k in (-90, -30, 15, 60, 150):
        t = T + k*M + rng.randrange(0, 60000)
        pts.append({"op":"mid","t":t,"zone":z}); ref.append(ref_mid(z, t))
        for s, e in W:
            pts.append({"op":"open","t":t,"zone":z,"s":s,"e":e}); ref.append(ref_open(z, t, s, e))
            pts.append({"op":"in","t":t,"zone":z,"s":s,"e":e}); ref.append(ref_in(z, t, s, e))
json.dump(pts, open("pts.json","w")); print("points", len(pts))
subprocess.check_call(["node","eval.mjs","pts.json","out.json"])
got = json.load(open("out.json"))
bad = []
for p, r, g in zip(pts, ref, got):
    if r != g: bad.append((p, r, g))
print("mismatches", len(bad))
byop = {}
for p, r, g in bad: byop.setdefault(p["op"], []).append((p, r, g))
for op, l in byop.items():
    print(op, len(l))
    for p, r, g in l[:6]: print("  ", json.dumps(p), "ref", r, "kit", g)
json.dump([{"p":p,"ref":r,"kit":g} for p,r,g in bad], open("bad.json","w"))
