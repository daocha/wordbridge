#!/usr/bin/env python3
"""Build the sharded English → Traditional Chinese dictionary data.

Source: ECDICT (https://github.com/skywind3000/ECDICT, MIT License).
Simplified Chinese is converted to Traditional Chinese with OpenCC.

Usage:
    python3 scripts/build_dict.py --csv ecdict.csv --out public/data \
        [--level standard] [--opencc s2tw]

Output layout (all plain JSON, served next to the app):
    meta.json          shard start keys, file sizes, word-of-the-day list, version
    s/<n>.json         range shard n: entries with key in [starts[n], starts[n+1])
                       entry = [word, phonetic, translation, definition, exchange,
                                collins, oxford, tags, rank, ipa_uk, ipa_us]
    t/<c>.json         suggestions for prefixes (starting with c) spanning >1 shard
    r/<n>.json         reverse index bucket: Chinese term -> English words
    s2t.json           Simplified -> Traditional character candidates for search input
"""

import argparse
import csv
import gzip
import hashlib
import json
import os
import re
import shutil
import sys
from collections import Counter, defaultdict

csv.field_size_limit(sys.maxsize)

SHARD_SIZE = 1500         # entries per range shard
MAX_TOP_PREFIX = 8        # longest prefix with precomputed suggestions
TOP_PER_PREFIX = 10       # suggestions stored per multi-shard prefix
REV_BUCKETS = 64          # reverse-index buckets
REV_PER_TERM = 12         # English words kept per Chinese term
UNRANKED = 999999

WORD_RE = re.compile(r"[A-Za-z][A-Za-z '\-.]*")
# Translations that are only a domain-specific gloss ([医] medical, [化] chemistry …)
# or only a web-mined gloss ([网络]) are low quality; the "standard" level skips
# words whose translation *starts* with one of these unless the word is common.
SPECIALIZED_RE = re.compile(r"^\[(网络|[\u4e00-\u9fff]{1,3}|IT)\]")
KEEP_TAGS = ("toefl", "ielts", "gre")


def clean(text):
    return text.replace("\\r", "").replace("\\n", "\n").replace("\r", "").strip()


def shard_key(word):
    """Lowercase key using only a-z and '_' (for any other character)."""
    return "".join(c if "a" <= c <= "z" else "_" for c in word.lower())


def gloss_of(translation):
    """Short one-line Chinese gloss for suggestion lists."""
    for line in translation.split("\n"):
        line = re.sub(r"^[a-z]+\.\s*", "", line.strip())
        if line and not line.startswith("["):
            return line[:40]
    first = translation.split("\n")[0]
    return re.sub(r"^\[[^\]]*\]\s*", "", first)[:40]


def rank_of(row):
    vals = [int(row[k] or 0) for k in ("frq", "bnc")]
    vals = [v for v in vals if v > 0]
    r = min(vals) if vals else UNRANKED
    # Words in Collins / Oxford 3000 without frequency data still deserve a boost.
    if r == UNRANKED and (row["collins"] or row["oxford"]):
        r = 60000
    return r


def load(csv_path, level, converter, pairs, ipa_uk, ipa_us):
    """Read ECDICT rows. `pairs` collects (simplified, traditional) character counts."""
    entries = []
    with open(csv_path, encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            word = row["word"].strip()
            trans = clean(row["translation"])
            if not trans or not WORD_RE.fullmatch(word):
                continue
            rank = rank_of(row)
            core = bool(row["collins"] or row["oxford"] or row["tag"]) or rank <= 60000
            plain = not SPECIALIZED_RE.match(trans)
            if level == "core" and not core:
                continue
            if level == "standard" and not (core or plain):
                continue
            converted = converter(trans)
            if len(converted) == len(trans):  # OpenCC s2t/s2tw/s2hk map 1:1 per char
                for a, b in zip(trans, converted):
                    if "\u3400" <= a <= "\u9fff":
                        pairs[a][b] += 1
            tags = " ".join(t for t in row["tag"].split() if t in KEEP_TAGS)
            entries.append([
                word,
                row["phonetic"].strip(),
                converted,
                clean(row["definition"]),
                row["exchange"].strip(),
                int(row["collins"] or 0),
                1 if row["oxford"] == "1" else 0,
                tags,
                rank,
                ipa_for(word, ipa_uk) or (normalize_ipa(row["phonetic"]) if row["phonetic"].strip() else ""),
                ipa_for(word, ipa_us),
            ])
    return entries


def build_shards(entries):
    """Pack the key-sorted entries into consecutive range shards.

    Shard i holds keys in [starts[i], starts[i+1]). Entries sharing a key (e.g.
    "China" / "china") always stay in the same shard. For every prefix whose words
    span more than one shard, the best suggestions are precomputed into top/<c>.json
    so the client never needs to load several shards to suggest.
    """
    shards, starts = [], []
    cur = []
    for e in entries:
        if len(cur) >= SHARD_SIZE and shard_key(e[0]) != shard_key(cur[-1][0]):
            shards.append(cur)
            cur = []
        cur.append(e)
    if cur:
        shards.append(cur)
    starts = [""] + [shard_key(s[0][0]) for s in shards[1:]]

    # Index of the shard each entry lives in.
    shard_of = {}
    for i, s in enumerate(shards):
        for e in s:
            shard_of[id(e)] = i

    by_prefix = defaultdict(list)
    for e in entries:
        k = shard_key(e[0])
        for n in range(1, min(len(k), MAX_TOP_PREFIX) + 1):
            by_prefix[k[:n]].append(e)

    top = defaultdict(dict)
    for prefix, items in by_prefix.items():
        if shard_of[id(items[0])] == shard_of[id(items[-1])]:
            continue  # a single shard covers this prefix
        items = sorted(items, key=lambda e: (e[8], len(e[0]), e[0]))
        out, seen = [], set()
        for e in items:
            if e[0].lower() in seen:
                continue
            seen.add(e[0].lower())
            out.append([e[0], gloss_of(e[2])])
            if len(out) >= TOP_PER_PREFIX:
                break
        top[prefix[0]][prefix] = out
    return shards, starts, top


REV_STRIP = re.compile(r"[（(\[【〔<《][^）)\]】〕>》]*[）)\]】〕>》]")
REV_SPLIT = re.compile(r"[；;，,、/]")
CJK_ONLY = re.compile(r"[\u3400-\u9fff]{1,8}")


def build_reverse(entries):
    """Chinese term -> best English words. Built from common words only."""
    terms = defaultdict(list)
    for e in entries:
        word, trans, rank = e[0], e[2], e[8]
        if rank > 40000 and not (e[5] or e[6]):
            continue
        if " " in word or word[:1].isupper() and rank > 10000:
            continue
        seen = set()
        for line in trans.split("\n"):
            if line.startswith("["):
                continue  # skip [網絡] / domain lines
            line = re.sub(r"^[a-z]+\.\s*", "", line.strip())
            line = REV_STRIP.sub("", line)
            for term in REV_SPLIT.split(line):
                term = term.strip().rstrip("的地").strip() or term.strip()
                term = term.strip()
                if CJK_ONLY.fullmatch(term) and term not in seen:
                    seen.add(term)
                    terms[term].append((rank, word))
    buckets = defaultdict(dict)
    for term, words in terms.items():
        words.sort()
        uniq = []
        for _, w in words:
            if w not in uniq:
                uniq.append(w)
            if len(uniq) >= REV_PER_TERM:
                break
        buckets[ord(term[0]) % REV_BUCKETS][term] = uniq
    return buckets


def build_s2t(pairs, converter):
    """Simplified → Traditional character table for converting search input.

    Derived from how OpenCC actually converted the dictionary text, so it matches
    the indexed terms. A character can have several candidates (发 → 發, 髮),
    most frequent first; the identity is kept when observed (后 → 後, 后).
    """
    table = {}
    for ch, counts in pairs.items():
        if all(t == ch for t in counts):
            continue
        total = sum(counts.values())
        cands = [t for t, n in counts.most_common() if n >= 2 or n / total >= 0.05][:3]
        table[ch] = "".join(cands) or converter(ch)
    # Common simplified characters that did not occur in the data.
    for code in range(0x4E00, 0x9FA6):
        ch = chr(code)
        if ch not in table and ch not in pairs:
            t = converter(ch)
            if t != ch and len(t) == 1:
                table[ch] = t
    return table


# ---------------------------------------------------------------- IPA (UK / US)
#
# ipa-dict (https://github.com/open-dict-data/ipa-dict, MIT): en_UK.txt, en_US.txt,
# lines of "word<TAB>/ipa/, /ipa2/". The UK list comes from espeak and puts stress
# marks after the onset ("təmˈɑːtəʊ"); we move them to the syllable start.

IPA_VOWELS = set("aeiouæɑɒɔəɛɜɪʊʌɐɚɝɘɵʉøœyɨɯɤ")
IPA_ONSETS = {
    "pl", "pr", "bl", "br", "tr", "dr", "kl", "kr", "ɡl", "ɡr", "fl", "fr", "θr", "ʃr",
    "sp", "st", "sk", "sm", "sn", "sl", "sw", "tw", "kw", "dw", "ɡw", "pj", "bj", "kj",
    "fj", "vj", "mj", "nj", "hj", "lj", "spr", "str", "skr", "spl", "skw", "stj", "skj",
}


def _fix_stress(ipa):
    out = list(ipa)
    i = 0
    while i < len(out):
        if out[i] in "ˈˌ" and i > 0 and out[i - 1] not in IPA_VOWELS and out[i - 1] not in "ːˈˌ.":
            mark = out.pop(i)
            j = i  # mark currently sits before out[i]; walk back over consonants
            while j > 0 and out[j - 1] not in IPA_VOWELS and out[j - 1] not in "ːˈˌ.ʊɪ":
                j -= 1
            cluster = "".join(out[j:i])
            if j > 0:  # word-internal: keep only a valid onset with the stressed syllable
                for n in range(len(cluster), 0, -1):
                    tail = cluster[-n:]
                    if n == 1 or tail in IPA_ONSETS or tail in ("tʃ", "dʒ"):
                        j = i - n
                        break
            out.insert(j, mark)
            i += 1
        i += 1
    return "".join(out)


def normalize_ipa(ipa, uk=False):
    ipa = ipa.strip().strip("/").strip()
    ipa = (ipa.replace("ɫ", "l").replace("ɹ", "r").replace("ɾ", "t").replace("ә", "ə")
              .replace("'", "ˈ").replace(":", "ː").replace("g", "ɡ"))
    if uk:
        ipa = ipa.replace("ɐ", "ə").replace("ᵻ", "ɪ")
        ipa = _fix_stress(ipa)
    return ipa


def load_ipa(path, uk):
    table = {}
    if not path:
        return table
    with open(path, encoding="utf-8") as f:
        for line in f:
            word, _, prons = line.rstrip("\n").partition("\t")
            if not prons:
                continue
            seen = []
            for p in prons.split(","):
                p = normalize_ipa(p, uk)
                if p and p not in seen:
                    seen.append(p)
            table.setdefault(word.lower(), seen[:2])
    return table


def ipa_for(word, table):
    """IPA for a word or a multi-word phrase (joined per word)."""
    w = word.lower()
    if w in table:
        return ", ".join(table[w])
    parts = w.split()
    if len(parts) > 1 and all(p in table for p in parts):
        return " ".join(table[p][0] for p in parts)
    return ""


def write_json(path, obj):
    data = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with open(path, "wb") as f:
        f.write(data)
    # Pre-compressed copy for nginx gzip_static.
    gz = gzip.compress(data, 9, mtime=0)
    with open(path + ".gz", "wb") as f:
        f.write(gz)
    return len(data), len(gz), hashlib.sha1(data).hexdigest()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", required=True, help="path to ecdict.csv")
    ap.add_argument("--out", default="public/data")
    ap.add_argument("--ipa-uk", help="ipa-dict en_UK.txt (optional, British IPA)")
    ap.add_argument("--ipa-us", help="ipa-dict en_US.txt (optional, American IPA)")
    ap.add_argument("--level", choices=("core", "standard", "full"), default="standard",
                    help="core ≈ 60k common words, standard ≈ 390k, full ≈ 760k")
    ap.add_argument("--opencc", default="s2tw",
                    help="OpenCC config: s2t, s2tw, s2twp (Taiwan phrases), s2hk")
    args = ap.parse_args()

    import opencc
    cc = opencc.OpenCC(args.opencc if args.opencc.endswith(".json") else args.opencc + ".json")

    print(f"Reading {args.csv} (level={args.level}, opencc={args.opencc}) …")
    pairs = defaultdict(Counter)
    ipa_uk = load_ipa(args.ipa_uk, uk=True)
    ipa_us = load_ipa(args.ipa_us, uk=False)
    print(f"  IPA: {len(ipa_uk):,} UK, {len(ipa_us):,} US pronunciations")
    entries = load(args.csv, args.level, cc.convert, pairs, ipa_uk, ipa_us)
    s2t = build_s2t(pairs, cc.convert)
    entries.sort(key=lambda e: (shard_key(e[0]), e[0]))
    print(f"  {len(entries):,} entries")

    shards, starts, top = build_shards(entries)
    reverse = build_reverse(entries)
    print(f"  {len(shards)} shards, {sum(len(t) for t in top.values()):,} multi-shard prefixes, "
          f"{sum(len(b) for b in reverse.values()):,} Chinese terms")

    if os.path.isdir(args.out):
        shutil.rmtree(args.out)
    for d in ("s", "t", "r"):
        os.makedirs(os.path.join(args.out, d))

    files, total_raw, total_gz, digest = {}, 0, 0, hashlib.sha1()

    def emit(name, obj):
        nonlocal total_raw, total_gz
        raw, gz, h = write_json(os.path.join(args.out, name + ".json"), obj)
        files[name] = gz
        total_raw, total_gz = total_raw + raw, total_gz + gz
        digest.update(h.encode())

    for i, shard in enumerate(shards):
        emit(f"s/{i}", shard)
    for c in sorted(top):
        emit(f"t/{c}", top[c])
    for b in sorted(reverse):
        emit(f"r/{b}", reverse[b])
    emit("s2t", s2t)

    # Word of the day: well-known but not trivial words.
    wotd = [e[0] for e in entries
            if 3000 <= e[8] <= 25000 and (e[5] >= 2 or e[6]) and e[0].isalpha() and e[0].islower()]
    wotd = wotd[:: max(1, len(wotd) // 730)][:730]

    meta = {
        "version": digest.hexdigest()[:12],
        "level": args.level,
        "opencc": args.opencc,
        "count": len(entries),
        "bytes": total_raw,
        "gzBytes": total_gz,
        "revBuckets": REV_BUCKETS,
        "starts": starts,
        "files": files,
        "wotd": wotd,
        "source": "ECDICT (MIT) + ipa-dict (MIT) + OpenCC",
    }
    write_json(os.path.join(args.out, "meta.json"), meta)
    print(f"  version {meta['version']}: {total_raw / 1e6:.1f} MB raw, {total_gz / 1e6:.1f} MB gzipped → {args.out}")


if __name__ == "__main__":
    main()
